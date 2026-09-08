import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  HUMOR_LEVELS,
  LISTING_STYLES,
  buildExpenseWrite,
  buildListingRequest,
  buildProjectTransferRequest,
  buildProjectGalleryUpdate,
  centsToAmount,
  mergeProjectGallery,
  photoLimitForPlan,
  projectPhotoRoles,
  parseMoneyToCents,
  projectCostCents,
  projectProfitCents,
  resolveNotesSave,
  roundLaborHours,
} from '../src/projectParity.js'

const detailSource = readFileSync(new URL('../src/pages/ProjectDetail.jsx', import.meta.url), 'utf8')
const createSource = readFileSync(new URL('../src/pages/NewProject.jsx', import.meta.url), 'utf8')
const gallerySource = readFileSync(new URL('../src/components/ProjectPhotoGallery.jsx', import.meta.url), 'utf8')
const dbSource = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8')
const quotaMigration = readFileSync(new URL('../supabase/migrations/20260807220000_enforce_project_photo_quota.sql', import.meta.url), 'utf8')

test('labor is required and rounded upward to the next quarter hour', () => {
  assert.equal(roundLaborHours('0.001'), 0.25)
  assert.equal(roundLaborHours('1.25'), 1.25)
  assert.equal(roundLaborHours('1.251'), 1.5)
  assert.equal(roundLaborHours(''), null)
  assert.throws(() => buildExpenseWrite({ description: 'Part', amount: '12', category: 'parts', laborHours: '' }), /labor hours/i)
  assert.deepEqual(buildExpenseWrite({ description: 'Part', amount: '12.30', category: 'parts', laborHours: '1.26' }), {
    description: 'Part', amount: 12.3, category: 'parts', laborHours: 1.5,
  })
})

test('money parsing is cent-safe and rejects fractions beyond cents', () => {
  assert.equal(parseMoneyToCents('0'), 0)
  assert.equal(parseMoneyToCents('12.30'), 1230)
  assert.equal(centsToAmount(1230), 12.3)
  assert.equal(parseMoneyToCents('12.301'), null)
  assert.equal(parseMoneyToCents('-1'), null)
})

test('project cost and realized profit stay in whole cents', () => {
  const sold = { status: 'sold', purchasePrice: 0.1, salePrice: 0.6, expenses: [{ amount: 0.2 }] }
  assert.equal(projectCostCents(sold), 30)
  assert.equal(projectProfitCents(sold), 30)
  assert.equal(projectProfitCents({ ...sold, status: 'active' }), null)
})

test('listing generator uses exact Android styles, humor, and bounded request contract', () => {
  assert.deepEqual(LISTING_STYLES, [
    { value: 'professional', label: 'Professional' },
    { value: 'normal', label: 'Normal' },
    { value: 'funny', label: 'Funny' },
  ])
  assert.deepEqual(HUMOR_LEVELS, [
    { value: 'subtle', label: 'Subtle' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'unhinged', label: 'Unhinged' },
  ])
  assert.deepEqual(buildListingRequest(' project-id ', 'funny', 'unhinged', ' old ', ' buyer facts '), {
    projectId: 'project-id', style: 'funny', humorLevel: 'unhinged', existingDescription: 'old', sellerBrief: 'buyer facts',
  })
  assert.throws(() => buildListingRequest('id', 'wild', null, '', 'facts'), /style/i)
})

test('race-safe notes resolution never replaces a newer draft or another project', () => {
  assert.deepEqual(resolveNotesSave({ targetProjectId: 'a', currentProjectId: 'a', saveRequest: 2, currentSaveRequest: 2, savedEditVersion: 3, currentEditVersion: 3 }), { applyProject: true, replaceDraft: true })
  assert.deepEqual(resolveNotesSave({ targetProjectId: 'a', currentProjectId: 'a', saveRequest: 2, currentSaveRequest: 2, savedEditVersion: 3, currentEditVersion: 4 }), { applyProject: true, replaceDraft: false })
  assert.deepEqual(resolveNotesSave({ targetProjectId: 'a', currentProjectId: 'b', saveRequest: 2, currentSaveRequest: 2, savedEditVersion: 3, currentEditVersion: 3 }), { applyProject: false, replaceDraft: false })
})

test('gallery preserves dedicated photos and existing backend attachment capacity', () => {
  assert.deepEqual(mergeProjectGallery({ photos: ['a', 'b'], beforePhoto: 'a', afterPhoto: 'c' }), ['a', 'b', 'c'])
  assert.deepEqual(mergeProjectGallery({ photo: 'legacy' }), ['legacy'])
  assert.deepEqual(mergeProjectGallery({ photos: [' ', 'a', 'a', null], photo: 'b', before_photo: 'c', after_photo: 'b' }), ['a', 'b', 'c'])
  assert.equal(photoLimitForPlan('free'), 5)
  assert.equal(photoLimitForPlan('pro'), 25)
})

test('gallery writes preserve order, synchronize main, and safely retain or clear legacy roles', () => {
  const existing = { photos: ['gallery', 'shared'], photo: 'legacy', beforePhoto: 'legacy', afterPhoto: 'shared' }
  assert.deepEqual(buildProjectGalleryUpdate(existing, ['shared', 'legacy', 'gallery']), {
    photos: ['shared', 'legacy', 'gallery'], photo: 'shared', beforePhoto: 'legacy', afterPhoto: 'shared',
  })
  assert.deepEqual(buildProjectGalleryUpdate(existing, ['gallery']), {
    photos: ['gallery'], photo: 'gallery', beforePhoto: null, afterPhoto: null,
  })
  assert.deepEqual(buildProjectGalleryUpdate({ photo: 'legacy' }, []), {
    photos: [], photo: null, beforePhoto: null, afterPhoto: null,
  })
  assert.deepEqual(projectPhotoRoles(existing, 'legacy'), ['Main', 'Before'])
  assert.deepEqual(projectPhotoRoles(existing, 'shared'), ['After'])
})

test('project gallery UI supports multi-select, preview, ordered controls, deletion, and plan limits', () => {
  assert.match(gallerySource, /multiple/)
  assert.match(gallerySource, /URL\.createObjectURL/)
  assert.match(gallerySource, /URL\.revokeObjectURL/)
  assert.match(gallerySource, /Move .* left|Move .* right/)
  assert.match(gallerySource, /Remove photo/)
  assert.match(gallerySource, /photoLimitForPlan/)
  assert.match(gallerySource, /deletePhoto\(userId/)
  assert.match(dbSource, /row\.photos =/)
  assert.match(createSource, /photos,/)
})

test('database remains authoritative for the same 5 Free and 25 Pro total-photo quota', () => {
  assert.match(quotaMigration, /verified_pro_entitlement\(new\.user_id\)[\s\S]*then 25[\s\S]*else 5/i)
  assert.match(quotaMigration, /new\.photos[\s\S]*new\.photo, new\.before_photo, new\.after_photo/i)
  assert.match(quotaMigration, /before insert or update of photos, photo, before_photo, after_photo, user_id/i)
})

test('V3 transfer request is idempotent and excludes attachments', () => {
  assert.deepEqual(buildProjectTransferRequest('project-1', 'mutation-1'), {
    projectId: 'project-1', options: { serviceExpenseIds: [] }, mutationId: 'mutation-1',
  })
})

test('project UI exposes VIN review, expense edit, listing, report, goal, integration, and undo sale actions', () => {
  for (const pattern of [/VIN Decoder/, /Edit Expense/, /Sales Listing Generator/, /Private PDF Report/, /Assign to Goal/, /Transfer to My Stuff/, /Undo Sale/, /Profit|Loss/]) {
    assert.match(detailSource, pattern)
  }
  assert.match(createSource, /Unconfirmed editable review/)
  assert.match(createSource, /manual entry/i)
  assert.match(createSource, /ProjectPhotoGallery/)
})
