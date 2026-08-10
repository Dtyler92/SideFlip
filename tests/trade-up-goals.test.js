import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { calculateGoalSummary, splitSaleProceeds, calculateTradeBasis, calculateProjectLinkFunding, shouldShowGoalOnboarding } from '../src/goals.js'

const source = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

test('shows the goal onboarding panel only before the first goal is created', () => {
  assert.equal(shouldShowGoalOnboarding([]), true)
  assert.equal(shouldShowGoalOnboarding([{ id: 'goal-1' }]), false)
})

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

test('linking an existing project splits its original purchase between goal and personal funding', () => {
  assert.deepEqual(calculateProjectLinkFunding(500, 300, 400), {
    goalFundingAmount: 300,
    outOfPocketAmount: 200,
  })
  assert.throws(() => calculateProjectLinkFunding(500, 501, 1000), /purchase price/)
  assert.throws(() => calculateProjectLinkFunding(500, 300, 299), /available toward the goal/)
})

test('repair migration restores owner-scoped atomic existing-project goal assignment', () => {
  const migration = source('supabase/migrations/20260810203000_restore_link_trade_up_project.sql')
  assert.match(migration, /security definer/)
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/)
  assert.match(migration, /where id = p_goal_id and user_id = v_user_id/)
  assert.match(migration, /where id = p_project_id and user_id = v_user_id/)
  assert.match(migration, /v_project\.status <> 'active'/)
  assert.match(migration, /v_project\.goal_id is not null/)
  assert.match(migration, /'goal_purchase'/)
  assert.match(migration, /out_of_pocket_amount = coalesce\(v_project\.purchase_price, 0\) - coalesce\(p_goal_funding, 0\)/)
  assert.match(migration, /revoke all on function public\.link_trade_up_project[\s\S]*from public/)
  assert.match(migration, /grant execute on function public\.link_trade_up_project[\s\S]*to authenticated/)
  assert.match(migration, /revoke all on function public\.create_trade_up_goal[\s\S]*from public/)
  assert.match(migration, /grant execute on function public\.create_trade_up_goal[\s\S]*to authenticated/)
  assert.doesNotMatch(migration, /grant execute[\s\S]*to anon/)
})

test('goal RPC ACL repair removes direct anonymous grants without blocking authenticated app use', () => {
  const migration = source('supabase/migrations/20260810205500_harden_trade_up_goal_rpc_grants.sql')
  assert.match(migration, /revoke execute on function public\.link_trade_up_project[\s\S]*from anon/)
  assert.match(migration, /revoke execute on function public\.create_trade_up_goal[\s\S]*from anon/)
  assert.match(migration, /revoke execute on function public\.enforce_free_active_trade_up_goal_limit\(\)[\s\S]*from anon, authenticated/)
  assert.match(migration, /grant execute on function public\.link_trade_up_project[\s\S]*to authenticated/)
  assert.match(migration, /grant execute on function public\.create_trade_up_goal[\s\S]*to authenticated/)
})
