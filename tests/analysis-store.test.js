import test from 'node:test'
import assert from 'node:assert/strict'
import { ANALYSIS_SCHEMA_VERSION, MAX_ANALYSIS_RECORD_BYTES, createAnalysisStore, normalizeSavedAnalyses } from '../src/storage/analysisStore.js'

function memoryStorage(){const values=new Map();return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}}
function record(id='a',overrides={}){return{schemaVersion:ANALYSIS_SCHEMA_VERSION,id,itemName:'Mower',projectId:null,platform:'facebook',currency:'USD',estimateSource:'user_entered',calculationVersion:1,analyzedAt:'2026-09-06T20:00:00.000Z',purchasePrice:100,estimatedExpenses:20,expectedSellingPrice:200,projectedProfit:80,projectedRoi:66.67,maximumPurchasePrice:160,recommendedListPrice:220,inputs:{purchasePrice:'100',repairsMaterials:'20',parts:'',fuelTravel:'',shippingCost:'',otherExpenses:'',expectedSellingPrice:'200',platformFeePct:'0',sellerPaidShipping:'',salesTaxOtherFees:'',desiredMinimumProfit:'40'},...overrides}}

test('normalization allowlists schema, currencies, platforms, fields, and unique IDs',()=>{
 const valid=record('same',{unknown:{private:'discard'}})
 const rows=normalizeSavedAnalyses([valid,record('same'),record('future',{schemaVersion:2}),record('currency',{currency:'BTC'}),record('bad',{inputs:{...valid.inputs,purchasePrice:{}}})])
 assert.equal(rows.length,1);assert.equal(rows[0].id,'same');assert.equal('unknown' in rows[0],false)
})

test('per-user keys isolate records and serialized mutations do not lose updates',async()=>{
 const store=createAnalysisStore(memoryStorage())
 await Promise.all([store.saveAnalysis('u1',record('a')),store.saveAnalysis('u1',record('b')),store.saveAnalysis('u2',record('c'))])
 assert.deepEqual((await store.loadSavedAnalyses('u1')).map(x=>x.id).sort(),['a','b'])
 assert.deepEqual((await store.loadSavedAnalyses('u2')).map(x=>x.id),['c'])
 await Promise.all([store.deleteSavedAnalysis('u1','a'),store.saveAnalysis('u1',record('d'))])
 assert.deepEqual((await store.loadSavedAnalyses('u1')).map(x=>x.id).sort(),['b','d'])
})

test('load guard refuses snapshots saved under another currency',async()=>{
 const store=createAnalysisStore(memoryStorage());await store.saveAnalysis('u',record())
 const saved=(await store.loadSavedAnalyses('u'))[0]
 assert.throws(()=>store.assertCurrency(saved,'EUR'),/saved in USD/)
 assert.equal(store.assertCurrency(saved,'USD').currency,'USD')
})

test('corrupt and oversized stores fail closed',async()=>{
 const storage=memoryStorage(),store=createAnalysisStore(storage)
 storage.values.set('sideflip:saved-analyses:u','{bad')
 await assert.rejects(store.loadSavedAnalyses('u'),/corrupted/)
 storage.values.set('sideflip:saved-analyses:u','x'.repeat(256001))
 await assert.rejects(store.loadSavedAnalyses('u'),/too large/)
})

test('unavailable storage is harmless before sign-in and fails clearly for mutations',async()=>{
 const store=createAnalysisStore(null)
 assert.deepEqual(await store.loadSavedAnalyses(null),[])
 await assert.rejects(store.saveAnalysis('u',record()),/storage is unavailable/i)
})

test('record limits count UTF-8 bytes rather than JavaScript characters',()=>{
 const numeric=`0e${'0'.repeat(240)}`
 const inputs=Object.fromEntries(Object.keys(record().inputs).map(field=>[field,numeric]))
 const unicode=record('漢'.repeat(100),{itemName:'漢'.repeat(120),projectId:'漢'.repeat(100),inputs})
 const serialized=JSON.stringify(unicode)
 assert.equal(serialized.length<=MAX_ANALYSIS_RECORD_BYTES,true)
 assert.equal(new TextEncoder().encode(serialized).byteLength>MAX_ANALYSIS_RECORD_BYTES,true)
 assert.deepEqual(normalizeSavedAnalyses([unicode]),[])
})
