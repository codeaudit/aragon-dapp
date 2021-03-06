// @flow
import { $ } from 'meteor/jquery'
import { Template } from 'meteor/templating'
import { FlowRouter } from 'meteor/kadira:flow-router'
import { ReactiveVar } from 'meteor/reactive-var'
import { ReactivePromise } from 'meteor/deanius:promise'

import ClosableSection from '/client/tmpl/components/closableSection'
import VotingWatcher from '/client/lib/ethereum/votings'
import StockWatcher from '/client/lib/ethereum/stocks'
import { Company } from '/client/lib/ethereum/deployed'
import Identity from '/client/lib/identity'
import { Stock, Voting } from '/client/lib/ethereum/contracts'
import { dispatcher, actions } from '/client/lib/action-dispatcher'
import Tokens from '/client/lib/ethereum/tokens'

const Votings = VotingWatcher.Votings
const Stocks = StockWatcher.Stocks

const tmpl = Template.Module_Voting_Section.extend([ClosableSection])

const votingVar = new ReactiveVar()
const updated = new ReactiveVar()
const verifiedVar = new ReactiveVar()
const isModifying = new ReactiveVar()

const voteId = () => FlowRouter.current().params.id
const voting = () => Votings.findOne({ $or: [{ address: voteId() }, { index: +voteId() }] })

const reload = () => {
  const identity = Identity.current(true) // so it reloads when balance reloads
  const newVoting = voting()
  verifiedVar.set(null)
  votingVar.set(newVoting)
  isModifying.set(false)
  updated.set(Math.random())
}

const allStocks = () => Stocks.find().fetch().map(s => Stock.at(s.address))

const getVotingPower = async () => {
  const address = Identity.current(true).ethereumAddress
  const vote = voting()

  // returns [ votable, modificable ]
  return await Company().votingPowerForVoting(vote.index, { from: address })
}

const canVote = async () => {
  const votingPower = await getVotingPower()
  return !voting().voteClosed && votingPower[0].toNumber() > 0 //.filter(x => x.toNumber() > 0).length > 0
}

const hasVoted = async () => {
  let [v, modificable, votedOption] = await getVotingPower()
  modificable = modificable.toNumber()
  votedOption = votedOption.toNumber()
  const voted = modificable > 0
  return { voted, votedOption, modificable }
}

const votingPower = async () => {
  const [votable] = await getVotingPower()
  return votable.toNumber()
}

// Pending votes stays here as it has to be updated in real time when more shares are assigned.
const pendingVotes = async (options) => {
  const vs = options.map((o, i) => Company().countVotes.call(voting().index, i))
  const allOptions = await Promise.all(vs)
  const total = allOptions[0][2].toNumber()
  const allVotes = allOptions.reduce((acc, v) => acc + v[0].toNumber(), 0)
  const votes = total - allVotes
  return { votes, relativeVotes: votes / total }
}

const willBeAbleToExecute = async () => {
  let [votable, modificable, votedOption] = await getVotingPower().then(xs => xs.map(x => x.toNumber()))
  if (votedOption != 10) votable += modificable // if didn't vote approve but can modify it
  const [currentVotes, totalVotes, totalVotingPower] = await Company().countVotes.call(voting().index, 0)
  const futureVotes = currentVotes + votable

  return futureVotes / totalVotingPower >= voting().supportNeeded
}

const canExecute = async (voteCounts, options) => {
  if (voting().voteExecuted !== null) return null

  const canPerform = await Company().canPerformAction(voting().mainSignature, voting().address)

  if (canPerform) {
    return { sentiment: 'primary', index: 0, name: options[0] }
  }

  /*
  const negativeVotes = voteCounts[1]
  if (negativeVotes.relativeVotes > 1 - voting().supportNeeded) {
    return { sentiment: 'negative', index: 1, name: options[1] }
  }
  */
  return null
}

tmpl.onCreated(function () {
  verifiedVar.set(null)
  this.autorun(() => {
    reload()
  })
})

tmpl.onRendered(() => {
  $('.tooltip').popup()
})

const wrappableTokens = async holder => {
  const stocks = Stocks.find().fetch().filter(s => s.parentToken)
  console.log('getting', stocks, holder)

  const r = (await Promise.all(stocks.map(s => Promise.all([s, Tokens.getBalance(s.parentToken.address, holder)]))))
    .filter(([stock, balance]) => balance > 0)
    .map(([stock, balance]) => {
      stock.parentToken.balance = balance
      return stock
    })
  console.log('r', r)
  return r
}

const formatEntity = entity => `<a href="${FlowRouter.current().path}/entity/${entity}" class="highlightedEntity">${entity}</a>`

const formatDescription = voting => {
  const space = ' '
  return voting.description
           .split(space)
           .map(x => _.contains(voting.entities, x) ? formatEntity(x) : x)
           .join(space)
}

tmpl.helpers({
  updatesHack: () => updated.get(),
  verified: () => verifiedVar.get(),
  voting: () => votingVar.get(),
  options: () => votingVar.get().options,
  voteCounts: () => votingVar.get().voteCounts,
  isClosed: vote => vote.voteClosed,
  canVote: ReactivePromise(canVote),
  canVoteOrModify: ReactivePromise(async modifyMode => modifyMode || await canVote()),
  pendingVotes: ReactivePromise(pendingVotes),
  votingPower: ReactivePromise(votingPower),
  executingOption: ReactivePromise(canExecute),
  isExecuted: option => votingVar.get().voteClosed && votingVar.get().voteExecuted === option,
  hasVoted: ReactivePromise(hasVoted),
  canModifyVote: modificableVotes => !votingVar.get().voteClosed && modificableVotes > 0,
  isModifying: () => isModifying.get(),
  getOption: o => votingVar.get().options[o - 10],
  wrappableTokens: ReactivePromise(wrappableTokens, [], console.log),
  stocks: Stocks.find(),
  willBeAbleToExecute: ReactivePromise(willBeAbleToExecute),
  getDescription: formatDescription,
})

const castVote = async option => {
  const executesOnDecided = $('#executesIfDecided').prop('checked') || false
  if (!isModifying.get()) { // TODO: OR is a removed delegated vote that wants to be modified
    await dispatcher.dispatch(actions.castVote, voting().index, option, executesOnDecided)
  } else {
    await dispatcher.dispatch(actions.modifyVote, voting().index, option, false, executesOnDecided)
    isModifying.set(false)
  }
}

const removeVote = async () => {
  await dispatcher.dispatch(actions.modifyVote, voting().index, 0, true, false)
}

const executeVote = async option => {
  await dispatcher.performTransaction(Voting.at(voting().address).executeOnAction, option, Company().address)
  reload()
}

const verify = async () => {
  const contract = await VotingWatcher.verifyVote(voting().address)
  return verifiedVar.set(contract ? contract.contractClass.contract_name : 'unknown')
}

tmpl.events({
  'click .voting.button': (e) => castVote($(e.currentTarget).data('option')),
  'click .execute.button': (e) => executeVote($(e.currentTarget).data('option')),
  'success .dimmer': () => FlowRouter.go('/voting'),
  'reload #votingSection': reload,
  'click #verifyCode': verify,
  'click #modifyVote': () => isModifying.set(true),
  'click #removeVote': () => removeVote(),
  'click #wrap': (e) => {
    const element = $(e.currentTarget)
    Tokens.wrap(element.data('parent'), element.data('wrapper'), element.data('holder'))
  },
})
