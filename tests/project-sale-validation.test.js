import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { validateProjectSalePrice } from '../src/projectSale.js'

test('goal-linked projects require a positive sale while ordinary projects may be given away', () => {
  assert.equal(validateProjectSalePrice({ goalId: 'goal-1' }, 0), 'Enter a sale price greater than zero for a project linked to a goal.')
  assert.equal(validateProjectSalePrice({ goal_id: 'goal-1' }, 0), 'Enter a sale price greater than zero for a project linked to a goal.')
  assert.equal(validateProjectSalePrice({}, 0), null)
  assert.equal(validateProjectSalePrice({ goalId: 'goal-1' }, 1), null)
})

test('sale screen runs goal-aware price validation before recording a sale', () => {
  const source = readFileSync(new URL('../src/pages/SellProject.jsx', import.meta.url), 'utf8')
  assert.match(source, /validateProjectSalePrice\(project, saleCents\)/)
  assert.match(source, /if \(salePriceError\) return alert\(salePriceError\)/)
})