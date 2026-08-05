import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateRealizedROI, getProfit, parseSalePrice } from '../src/store.js'

function project({ status = 'sold', purchasePrice = 0, salePrice = null, expenses = [] } = {}) {
  return {
    status,
    purchasePrice,
    salePrice,
    expenses: expenses.map(amount => ({ amount })),
  }
}

test('realized ROI is unavailable when there are no sold projects', () => {
  const projects = [project({ status: 'active', purchasePrice: 100, salePrice: null })]

  assert.equal(calculateRealizedROI(projects), null)
})

test('realized ROI reports a loss for one sold project', () => {
  const projects = [project({ purchasePrice: 100, salePrice: 80 })]

  assert.equal(calculateRealizedROI(projects), -20)
})

test('realized ROI excludes active projects from both profit and cost basis', () => {
  const projects = [
    project({ purchasePrice: 100, salePrice: 150 }),
    project({ status: 'active', purchasePrice: 900, salePrice: null }),
  ]

  assert.equal(calculateRealizedROI(projects), 50)
})

test('realized ROI is zero when a project sells exactly at cost', () => {
  const projects = [project({ purchasePrice: 100, salePrice: 100 })]

  assert.equal(calculateRealizedROI(projects), 0)
})

test('a missing sale price keeps the unsold profit sentinel', () => {
  assert.equal(getProfit(project({ status: 'active', purchasePrice: 100, salePrice: null })), null)
})

test('a project sold for zero records the full loss', () => {
  const soldForZero = project({ purchasePrice: 100, salePrice: 0 })

  assert.equal(getProfit(soldForZero), -100)
  assert.equal(calculateRealizedROI([soldForZero]), -100)
})

test('realized ROI includes expenses in sold-project cost basis', () => {
  const projects = [project({ purchasePrice: 100, salePrice: 180, expenses: [20, 30] })]

  assert.equal(calculateRealizedROI(projects), 20)
})

test('realized ROI uses weighted aggregate sold-project cost basis', () => {
  const projects = [
    project({ purchasePrice: 100, salePrice: 200 }),
    project({ purchasePrice: 900, salePrice: 900 }),
  ]

  assert.equal(calculateRealizedROI(projects), 10)
})

test('sale price parsing accepts zero and rejects empty, negative, or non-numeric values', () => {
  assert.equal(parseSalePrice('0'), 0)
  assert.equal(parseSalePrice('125.50'), 125.5)
  assert.equal(parseSalePrice(''), null)
  assert.equal(parseSalePrice('-1'), null)
  assert.equal(parseSalePrice('not-a-number'), null)
})

test('realized ROI is unavailable when sold-project cost basis is zero', () => {
  const projects = [project({ purchasePrice: 0, salePrice: 100 })]

  assert.equal(calculateRealizedROI(projects), null)
})
