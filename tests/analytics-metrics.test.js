import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { calculatePortfolioMetrics, formatLaborHours } from '../src/analyticsMetrics.js'

const analyticsSource = readFileSync(new URL('../src/pages/Analytics.jsx', import.meta.url), 'utf8')

test('portfolio metrics use Android zero behavior when there are no sold projects', () => {
  assert.deepEqual(calculatePortfolioMetrics([
    { status: 'active', purchasePrice: 100, expenses: [{ amount: 25, laborHours: 3 }] },
  ]), {
    totalProfit: 0,
    totalRevenue: 0,
    avgProfit: 0,
    totalLaborHours: 0,
    hourlyEarnings: null,
  })
  assert.equal(formatLaborHours(0), '0')
})

test('sold projects with zero labor remain in portfolio metrics but not hourly earnings', () => {
  assert.deepEqual(calculatePortfolioMetrics([
    { status: 'sold', purchasePrice: 100, salePrice: 250, expenses: [{ amount: 50, laborHours: 0 }] },
  ]), {
    totalProfit: 100,
    totalRevenue: 250,
    avgProfit: 100,
    totalLaborHours: 0,
    hourlyEarnings: null,
  })
})

test('losses produce negative average profit and labor earnings', () => {
  assert.deepEqual(calculatePortfolioMetrics([
    { status: 'sold', purchasePrice: 100, salePrice: 80, expenses: [{ amount: 20, laborHours: 2 }] },
  ]), {
    totalProfit: -40,
    totalRevenue: 80,
    avgProfit: -40,
    totalLaborHours: 2,
    hourlyEarnings: -20,
  })
})

test('labor earnings include only sold projects that record labor', () => {
  assert.deepEqual(calculatePortfolioMetrics([
    { status: 'sold', purchasePrice: 10, salePrice: 1010, expenses: [] },
    { status: 'sold', purchasePrice: 100, salePrice: 250, expenses: [{ amount: 50, laborHours: 2 }] },
    { status: 'active', purchasePrice: 10, expenses: [{ amount: 5, laborHours: 10 }] },
  ]), {
    totalProfit: 1100,
    totalRevenue: 1260,
    avgProfit: 550,
    totalLaborHours: 2,
    hourlyEarnings: 50,
  })
})

test('monetary aggregation is cent-safe and labor uses hours rounded for display', () => {
  assert.deepEqual(calculatePortfolioMetrics([
    { status: 'sold', purchasePrice: 0.1, salePrice: 0.6, expenses: [{ amount: 0.2, laborHours: 0.25 }] },
    { status: 'sold', purchasePrice: 0.2, salePrice: 0.7, expenses: [{ amount: 0.1, laborHours: 0.5 }] },
  ]), {
    totalProfit: 0.7,
    totalRevenue: 1.3,
    avgProfit: 0.35,
    totalLaborHours: 0.75,
    hourlyEarnings: 0.9333333333333332,
  })
  assert.equal(formatLaborHours(1234.5), '1,234.5')
  assert.equal(formatLaborHours(1.257), '1.26')
})

test('analytics exposes all Android portfolio cards with accessible metric labels', () => {
  for (const label of ['Avg Profit / Flip', 'Total Revenue', 'Profit per Labor Hour', 'Labor Recorded']) {
    assert.match(analyticsSource, new RegExp(`label="${label}"`))
  }
  assert.match(analyticsSource, /role="group"/)
  assert.match(analyticsSource, /aria-label=\{accessibilityLabel\}/)
  assert.match(analyticsSource, /hourlyEarnings === null \? '—'/)
  assert.match(analyticsSource, /\$\{laborHoursLabel\}h/)
})
