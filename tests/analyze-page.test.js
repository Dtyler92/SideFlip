import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const page=readFileSync(new URL('../src/pages/Analyze.jsx',import.meta.url),'utf8')

test('responsive Analyze page exposes every Android 1.4.0 tool and disclosure',()=>{
 for(const term of ['Deal Analyzer','Quick Deal Check','List Price Calculator','Maximum Buy Price','Profit Calculator','Estimated resale values are entered by you']) assert.match(page,new RegExp(term,'i'))
 assert.match(page,/ROI_PRESETS/);assert.match(page,/PLATFORM_PRESETS/);assert.match(page,/@media/)
})

test('page is reusable for parent route prefill and never writes project records',()=>{
 assert.match(page,/export default function Analyze\(\{ projectId/)
 assert.match(page,/projectAnalysisDraft/)
 assert.match(page,/private analysis copy/i)
 assert.doesNotMatch(page,/updateProject|supabase\.from|\.insert\(/)
})

test('page has accessible live results, labeled controls, project dialog, and saved actions',()=>{
 assert.match(page,/aria-live="polite"/)
 assert.match(page,/<label/)
 assert.match(page,/role="dialog"/)
 assert.match(page,/aria-modal="true"/)
 assert.match(page,/Load .* analysis/)
 assert.match(page,/Delete .* analysis/)
})
