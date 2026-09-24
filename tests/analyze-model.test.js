import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEAL_RATING_THRESHOLDS, MINIMUM_OFFER_LIST_PRICE_RATIO, analyzeDeal,
  calculateListPrice, calculateMaximumBuyPrice, calculateProfit,
  normalizeCurrencyAmount, projectAnalysisDraft, quickDealCheck, rateDeal,
} from '../src/domain/analyzeModel.js'

test('Deal Analyzer preserves the Android 1.4.0 formulas at cent precision', () => {
  assert.deepEqual(analyzeDeal({ purchasePrice:200, repairsMaterials:50, parts:25, fuelTravel:10, shippingCost:15, otherExpenses:5, expectedSellingPrice:500, platformFeePct:13, sellerPaidShipping:20, salesTaxOtherFees:5, desiredMinimumProfit:100 }), {
    totalInvestment:305, expectedRevenue:500, platformFees:65, totalSellingCosts:90,
    expectedProfit:105, profitMarginPct:21, roiPct:34.43, breakEvenSellingPrice:379.31,
    maximumPurchasePrice:205, dealRating:'GOOD FLIP', ratingTone:'positive',
    ratingExplanation:'This deal appears to have a solid projected return based on your estimates.',
  })
})

test('Quick Deal Check gives the fast buy-or-pass values and rating', () => {
  assert.deepEqual(quickDealCheck({ askingPrice:200, estimatedRepairs:75, expectedResaleValue:500, desiredMinimumProfit:200 }), {
    expectedInvestment:275, expectedProfit:225, roiPct:81.82, maximumBuyPrice:225,
    dealRating:'GREAT FLIP', ratingTone:'strong', ratingExplanation:'This deal appears to have a strong projected return based on your estimates.',
  })
})

test('List Price supports profit-dollar and ROI targets and a protected offer floor', () => {
  const dollars=calculateListPrice({totalInvested:405,targetMode:'profit',targetValue:190,platformFeePct:13})
  assert.equal(dollars.recommendedListPrice,683.91)
  assert.equal(dollars.expectedProfit,190)
  assert.equal(dollars.breakEvenPrice,465.52)
  assert.equal(dollars.suggestedMinimumOffer,629.2)
  assert.equal(dollars.minimumOfferExpectedProfit,142.4)
  assert.equal(dollars.minimumOfferTargetComparison,'below')
  assert.equal(MINIMUM_OFFER_LIST_PRICE_RATIO,.92)
  const roi=calculateListPrice({totalInvested:400,targetMode:'roi',targetValue:50,platformFeePct:0})
  assert.equal(roi.targetProfit,200)
  assert.equal(roi.recommendedListPrice,600)
  assert.equal(roi.expectedRoiPct,50)
})

test('Maximum Buy Price and Profit Calculator include all selling costs', () => {
  assert.deepEqual(calculateMaximumBuyPrice({expectedSellingPrice:500,nonPurchaseExpenses:100,desiredMinimumProfit:200,platformFeePct:10,sellerPaidShipping:25,otherSellingCosts:5}), {maximumPurchasePrice:120,platformFees:50,totalSellingCosts:80,feasible:true})
  assert.deepEqual(calculateProfit({totalInvested:300,sellingPrice:500,platformFeePct:10,sellerPaidShipping:25,additionalSellingCosts:5}), {platformFees:50,totalSellingCosts:80,expectedProfit:120,profitMarginPct:24,roiPct:40,breakEvenPrice:366.67})
  assert.equal(calculateMaximumBuyPrice({expectedSellingPrice:50,nonPurchaseExpenses:100,desiredMinimumProfit:1}).feasible,false)
})

test('ratings cover loss, break-even, thresholds, and positive zero-cost deals', () => {
  assert.equal(rateDeal({expectedProfit:-1,roiPct:-1}).dealRating,'LOSS')
  assert.equal(rateDeal({expectedProfit:0,roiPct:0}).dealRating,'LOW MARGIN')
  const zero=analyzeDeal({purchasePrice:0,expectedSellingPrice:1000})
  assert.equal(zero.roiPct,null)
  assert.equal(zero.dealRating,'GREAT FLIP')
  assert.match(zero.ratingExplanation,/ROI is unavailable/)
  assert.equal(DEAL_RATING_THRESHOLDS.great.minRoiPct,50)
})

test('all inputs are nonnegative, bounded, finite, and normalized to cents', () => {
  assert.equal(normalizeCurrencyAmount(-10),0)
  const result=analyzeDeal({purchasePrice:10.009,otherExpenses:.009,expectedSellingPrice:20.009,platformFeePct:999})
  assert.equal(result.totalInvestment,10.02)
  assert.equal(result.expectedRevenue,20.01)
  assert.equal(result.platformFees,20.01)
  assert.equal(result.expectedProfit,-10.02)
  const extreme=calculateListPrice({totalInvested:'9'.repeat(120),targetMode:'roi',targetValue:'9'.repeat(120),platformFeePct:99.99,sellerPaidShipping:'9'.repeat(120),additionalSellingCosts:'9'.repeat(120)})
  for (const value of Object.values(extreme)) if (typeof value==='number') assert.equal(Number.isFinite(value),true)
  assert.equal(extreme.targetProfit,5000000000)
})

test('existing-project prefill is a private copy and supports normalized web projects', () => {
  const project={id:'p1',title:'Mower',purchasePrice:300,expenses:[{category:'parts',amount:45},{category:'transport',amount:12},{category:'supplies',amount:20},{category:'other',amount:7}]}
  const before=structuredClone(project)
  assert.deepEqual(projectAnalysisDraft(project),{projectId:'p1',itemName:'Mower',purchasePrice:300,repairsMaterials:20,parts:45,fuelTravel:12,shippingCost:0,otherExpenses:7,totalInvested:384})
  assert.deepEqual(project,before)
})
