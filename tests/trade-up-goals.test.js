import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateGoalSummary, splitSaleProceeds, calculateTradeBasis } from '../src/goals.js'

test('keeps multiple goals financially isolated', () => {
  const projects = [
    { goalId: 'goal-a', status: 'active', purchasePrice: 400, outOfPocketAmount: 100, expenses: [{ amount: 50 }] },
    { goalId: 'goal-b', status: 'active', purchasePrice: 900, outOfPocketAmount: 900, expenses: [] },
  ]
  const ledger = [
    { goalId: 'goal-a', type: 'personal_contribution', amount: 500 },
    { goalId: 'goal-a', type: 'goal_purchase', amount: -300 },
    { goalId: 'goal-b', type: 'sale_proceeds', amount: 1000 },
  ]

  assert.deepEqual(calculateGoalSummary({ id: 'goal-a', targetAmount: 2000 }, projects, ledger), {
    available: 200,
    activeValue: 450,
    progressValue: 650,
    progressPercent: 32.5,
    personalContributions: 650,
    personalCashInvested: 650,
    proceedsReinvested: 0,
    currentGoalCapital: 650,
    totalProjectExpenses: 50,
    realizedProfit: 0,
    takenOut: 0,
    activeCount: 1,
    soldCount: 0,
  })
})

test('reusing sale proceeds does not increase personal cash invested', () => {
  const projects = [
    { goalId: 'goal', status: 'sold', purchasePrice: 500, salePrice: 800, outOfPocketAmount: 500, expenses: [] },
    { goalId: 'goal', status: 'active', purchasePrice: 800, outOfPocketAmount: 0, expenses: [] },
  ]
  const ledger = [
    { goalId: 'goal', type: 'sale_proceeds', amount: 800 },
    { goalId: 'goal', type: 'goal_purchase', amount: -800 },
  ]
  const summary = calculateGoalSummary({ id: 'goal', targetAmount: 2000 }, projects, ledger)
  assert.equal(summary.personalCashInvested, 500)
  assert.equal(summary.proceedsReinvested, 800)
  assert.equal(summary.currentGoalCapital, 800)
  assert.equal(summary.realizedProfit, 300)
})

test('sale split returns all proceeds then records the amount taken out', () => {
  assert.deepEqual(splitSaleProceeds(1200, 800), [
    { type: 'sale_proceeds', amount: 1200 },
    { type: 'cash_out', amount: -400 },
  ])
  assert.throws(() => splitSaleProceeds(100, 101), /between zero and the sale price/)
})

test('direct trade basis includes cash paid and subtracts cash received', () => {
  assert.equal(calculateTradeBasis({ tradeCredit: 1500, cashDirection: 'paid', cashAmount: 500 }), 2000)
  assert.equal(calculateTradeBasis({ tradeCredit: 1500, cashDirection: 'received', cashAmount: 300 }), 1200)
})
