import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  accessibleActiveGoalsAfterProLoss,
  calculateGoalSummary,
  calculateProjectLinkFunding,
  canCompleteGoal,
  isGoalLockedAfterProLoss,
  normalizeMoney,
  progressColor,
  validateGoalDraft,
} from '../src/goals.js'

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('goal drafts require a finite positive target for item and amount goals', () => {
  for (const goalType of ['item', 'amount']) {
    for (const targetAmount of ['', '0', '-1', 'Infinity', 'NaN']) {
      assert.throws(
        () => validateGoalDraft({ name: 'Goal', goalType, targetItem: 'Truck', targetAmount, startingAmount: '' }),
        /target amount/i,
      )
    }
  }

  assert.throws(
    () => validateGoalDraft({ name: 'Goal', goalType: 'item', targetItem: '', targetAmount: '1', startingAmount: '' }),
    /target item/i,
  )
  assert.throws(
    () => validateGoalDraft({ name: 'Goal', goalType: 'other', targetAmount: '1', startingAmount: '' }),
    /goal type/i,
  )
})

test('goal drafts reject non-finite or negative starts and normalize money to cents', () => {
  for (const startingAmount of ['-0.01', '-1', 'Infinity', 'NaN']) {
    assert.throws(
      () => validateGoalDraft({ name: 'Goal', goalType: 'amount', targetAmount: '10', startingAmount }),
      /starting amount/i,
    )
  }

  assert.equal(normalizeMoney(10.005), 10.01)
  assert.equal(normalizeMoney(0.1 + 0.2), 0.3)
  assert.deepEqual(
    validateGoalDraft({ name: '  Goal  ', goalType: 'item', targetItem: '  Truck  ', targetAmount: '123.456', startingAmount: '1.005', description: '  Why  ' }),
    { name: 'Goal', goalType: 'item', targetItem: 'Truck', targetAmount: 123.46, startingAmount: 1.01, description: 'Why' },
  )
})

test('summary matches Android metrics while retaining existing web metrics and cent precision', () => {
  const goal = { id: 'goal', targetAmount: 1000 }
  const projects = [
    { id: 'sold', goalId: 'goal', status: 'sold', purchasePrice: 100.10, salePrice: 250.25, outOfPocketAmount: 60.05, expenses: [{ amount: 10.10 }] },
    { id: 'active', goalId: 'goal', status: 'active', purchasePrice: 200.20, outOfPocketAmount: 50.05, expenses: [{ amount: 20.20 }] },
  ]
  const ledger = [
    { goalId: 'goal', type: 'personal_contribution', amount: 40.05 },
    { goalId: 'goal', type: 'sale_proceeds', amount: 250.25 },
    { goalId: 'goal', type: 'goal_purchase', amount: -200.20 },
  ]

  const summary = calculateGoalSummary(goal, projects, ledger)
  assert.equal(summary.available, 90.10)
  assert.equal(summary.activeValue, 220.40)
  assert.equal(summary.progressValue, 310.50)
  assert.equal(summary.outOfPocket, 180.45)
  assert.equal(summary.grossFlipped, 250.25)
  assert.equal(summary.flipped, 250.25)
  assert.equal(summary.personalCashInvested, 180.45)
  assert.equal(summary.proceedsReinvested, 160.15)
  assert.equal(summary.totalProjectExpenses, 30.30)
  assert.equal(summary.realizedProfit, 140.05)
})

test('completion requires a positive target that current progress fully funds', () => {
  assert.equal(canCompleteGoal({ targetAmount: 0 }, { progressValue: 100 }), false)
  assert.equal(canCompleteGoal({ targetAmount: 100 }, { progressValue: 99.99 }), false)
  assert.equal(canCompleteGoal({ targetAmount: 100 }, { progressValue: 100 }), true)
  assert.equal(canCompleteGoal({ target_amount: '100.005' }, { progressValue: 100.01 }), true)
})

test('progress color transitions from SideFlip red to reached-target green', () => {
  assert.equal(progressColor(0), '#C8402F')
  assert.equal(progressColor(100), '#2D7A4F')
  assert.notEqual(progressColor(50), progressColor(0))
  assert.equal(progressColor(500), '#2D7A4F')
})

test('Free downgrade keeps only the deterministic oldest active goal usable', () => {
  const goals = [
    { id: 'z', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'a', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'completed', status: 'completed', createdAt: '2025-01-01T00:00:00Z' },
  ]

  assert.equal(isGoalLockedAfterProLoss(goals[0], goals, 'free'), true)
  assert.equal(isGoalLockedAfterProLoss(goals[1], goals, 'free'), false)
  assert.equal(isGoalLockedAfterProLoss(goals[2], goals, 'free'), false)
  assert.deepEqual(accessibleActiveGoalsAfterProLoss(goals, 'free').map(goal => goal.id), ['a'])
  assert.deepEqual(accessibleActiveGoalsAfterProLoss(goals, 'pro').map(goal => goal.id), ['z', 'a'])
})

test('invalid timestamps sort after valid timestamps and still tie by ID', () => {
  const goals = [
    { id: 'b', status: 'active', createdAt: null },
    { id: 'a', status: 'active', createdAt: 'not-a-date' },
    { id: 'valid', status: 'active', createdAt: '2026-02-01T00:00:00Z' },
  ]
  assert.deepEqual(accessibleActiveGoalsAfterProLoss(goals, 'free').map(goal => goal.id), ['valid'])

  const invalidOnly = goals.slice(0, 2)
  assert.deepEqual(accessibleActiveGoalsAfterProLoss(invalidOnly, 'free').map(goal => goal.id), ['a'])
})

test('project linking validates finite nonnegative values and normalizes cents', () => {
  assert.deepEqual(calculateProjectLinkFunding('500.005', '300.004', '400'), {
    goalFundingAmount: 300,
    outOfPocketAmount: 200.01,
  })
  assert.throws(() => calculateProjectLinkFunding(Infinity, 1, 1), /finite/i)
  assert.throws(() => calculateProjectLinkFunding(1, -1, 1), /negative/i)
})

test('goals UI exposes parity states and rechecks access before every mutation', () => {
  const goals = source('src/pages/Goals.jsx')
  assert.match(goals, /selected\.description/)
  assert.match(goals, /progressColor\(/)
  assert.match(goals, /canCompleteGoal\(/)
  assert.match(goals, /aria-live="polite"/)
  assert.match(goals, /Reopen Goal/)
  assert.match(goals, /Save Target Amount/)
  assert.match(goals, /isGoalLockedAfterProLoss\(/)
  assert.match(goals, /getCurrentlyAccessibleGoal/)
  for (const handler of ['handleAdjustment', 'handleLinkProject', 'handleTrade', 'setGoalStatus', 'saveTargetAmount', 'removeGoal']) {
    assert.match(goals, new RegExp(`(?:async function|function) ${handler}[\\s\\S]{0,500}getCurrentlyAccessibleGoal`), `${handler} must recheck goal access at mutation time`)
  }
  assert.match(goals, /SideFlip Pro required/)
  assert.match(goals, /aria-disabled="true"/)
  assert.match(goals, /Gross Flipped/)
  assert.match(goals, /Out of Pocket/)
})

test('database goal writes keep accounting RPCs and normalize validated amounts', () => {
  const db = source('src/db.js')
  for (const rpc of ['create_trade_up_goal', 'adjust_trade_up_goal', 'link_trade_up_project', 'record_trade_up_direct_trade', 'delete_trade_up_goal']) {
    assert.match(db, new RegExp(`rpc\\('${rpc}'`))
  }
  assert.match(db, /validateGoalDraft\(goal\)/)
  assert.match(db, /normalizeMoney\(updates\.targetAmount/)
  assert.match(db, /normalizeMoney\(amount/)
  assert.match(db, /\['personal_contribution', 'cash_out'\]\.includes\(type\)/)
  assert.match(db, /Trade credit must be greater than zero/)
  assert.match(db, /Goal cash cannot exceed cash paid/)
  assert.match(db, /Cash kept cannot exceed cash received/)
})
