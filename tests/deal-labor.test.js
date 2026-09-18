import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeDeal,
  calculateHourlyPay,
  calculateListPrice,
  calculateRequiredProfit,
  roundUpQuarterHours,
} from '../src/dealLabor.js'

test('hours round up to the next quarter hour', () => {
  assert.equal(roundUpQuarterHours(0.01), 0.25)
  assert.equal(roundUpQuarterHours(0.25), 0.25)
  assert.equal(roundUpQuarterHours(0.26), 0.5)
  assert.equal(roundUpQuarterHours(1.01), 1.25)
  assert.equal(roundUpQuarterHours(1.25), 1.25)
  assert.equal(roundUpQuarterHours(3), 3)
})

test('invalid hour inputs are unknown, not zero', () => {
  for (const bad of ['', null, undefined, 0, -1, 'abc', NaN, Infinity]) {
    assert.equal(roundUpQuarterHours(bad), null)
  }
})

test('hourly pay divides profit by rounded hours', () => {
  assert.equal(calculateHourlyPay({ profit: 200, hours: 4 }), 50)
  // 3.1 hours rounds up to 3.25 before dividing
  assert.equal(calculateHourlyPay({ profit: 325, hours: 3.1 }), 100)
})

test('hourly pay stays negative for a losing deal', () => {
  assert.equal(calculateHourlyPay({ profit: -100, hours: 2 }), -50)
})

test('hourly pay is unavailable without hours', () => {
  assert.equal(calculateHourlyPay({ profit: 500, hours: '' }), null)
  assert.equal(calculateHourlyPay({ profit: 500 }), null)
})

test('zero profit is a real answer, not missing data', () => {
  assert.equal(calculateHourlyPay({ profit: 0, hours: 2 }), 0)
})

test('required profit comes from hours times target rate', () => {
  assert.equal(calculateRequiredProfit({ hours: 4, hourlyRate: 25 }), 100)
  assert.equal(calculateRequiredProfit({ hours: 4, hourlyRate: 0 }), null)
  assert.equal(calculateRequiredProfit({ hours: '', hourlyRate: 25 }), null)
})

test('list price covers platform fees', () => {
  assert.equal(calculateListPrice({ invested: 100, profit: 50, feePct: 0 }), 150)
  // netting 150 after a 13% fee needs 150 / 0.87
  assert.ok(Math.abs(calculateListPrice({ invested: 100, profit: 50, feePct: 13 }) - 172.4138) < 0.001)
})

test('a fee of 100 percent or more has no valid list price', () => {
  assert.equal(calculateListPrice({ invested: 100, profit: 50, feePct: 100 }), null)
  assert.equal(calculateListPrice({ invested: 100, profit: 50, feePct: 140 }), null)
  assert.equal(calculateListPrice({ invested: 100, profit: 50, feePct: -5 }), null)
})

test('deal analysis without labor inputs keeps the original price math', () => {
  const r = analyzeDeal({ invested: 200, targetPct: 50, feePct: 0 })

  assert.equal(r.listPrice, 300)
  assert.equal(r.profit, 100)
  assert.equal(r.roi, 50)
  assert.equal(r.hours, null)
  assert.equal(r.hourlyPay, null)
  assert.equal(r.requiredProfit, null)
  assert.equal(r.meetsTarget, null)
})

test('deal analysis reports pay per hour when hours are estimated', () => {
  const r = analyzeDeal({ invested: 200, targetPct: 50, feePct: 0, estimatedHours: 4 })

  assert.equal(r.profit, 100)
  assert.equal(r.hours, 4)
  assert.equal(r.hourlyPay, 25)
})

test('deal analysis compares against a target hourly rate', () => {
  const good = analyzeDeal({
    invested: 200, targetPct: 50, feePct: 0, estimatedHours: 2, targetHourlyRate: 25,
  })
  assert.equal(good.hourlyPay, 50)
  assert.equal(good.requiredProfit, 50)
  assert.equal(good.requiredListPrice, 250)
  assert.equal(good.meetsTarget, true)

  const bad = analyzeDeal({
    invested: 200, targetPct: 50, feePct: 0, estimatedHours: 10, targetHourlyRate: 25,
  })
  assert.equal(bad.hourlyPay, 10)
  assert.equal(bad.requiredProfit, 250)
  assert.equal(bad.requiredListPrice, 450)
  assert.equal(bad.meetsTarget, false)
})

test('required list price accounts for fees', () => {
  const r = analyzeDeal({
    invested: 100, targetPct: 50, feePct: 13, estimatedHours: 2, targetHourlyRate: 20,
  })

  assert.equal(r.requiredProfit, 40)
  assert.ok(Math.abs(r.requiredListPrice - 140 / 0.87) < 0.001)
})

test('zero invested yields no ROI rather than a divide by zero', () => {
  const r = analyzeDeal({ invested: 0, targetPct: 50, feePct: 0, estimatedHours: 2 })

  assert.equal(r.roi, null)
  assert.equal(r.profit, 0)
  assert.equal(r.hourlyPay, 0)
})
