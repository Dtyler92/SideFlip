export const LISTING_STYLES = Object.freeze([
  { value: 'professional', label: 'Professional' },
  { value: 'normal', label: 'Normal' },
  { value: 'funny', label: 'Funny' },
])

export const HUMOR_LEVELS = Object.freeze([
  { value: 'subtle', label: 'Subtle' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'unhinged', label: 'Unhinged' },
])

const STYLE_VALUES = new Set(LISTING_STYLES.map(option => option.value))
const HUMOR_VALUES = new Set(HUMOR_LEVELS.map(option => option.value))

export function roundLaborHours(value) {
  const hours = Number(value)
  if (!Number.isFinite(hours) || hours <= 0) return null
  return Math.ceil((hours * 4) - 1e-9) / 4
}

export function parseMoneyToCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    const cents = Math.round(value * 100)
    return Math.abs(value * 100 - cents) < 1e-7 ? cents : null
  }
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const cents = (Number(whole) * 100) + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

export function centsToAmount(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('A whole number of cents is required.')
  return cents / 100
}

function storedAmountToCents(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0
}

export function projectCostCents(project = {}) {
  return storedAmountToCents(project.purchasePrice ?? project.purchase_price)
    + (project.expenses || []).reduce((sum, expense) => sum + storedAmountToCents(expense.amount), 0)
}

export function projectProfitCents(project = {}) {
  const saleValue = project.salePrice ?? project.sale_price
  if (project.status !== 'sold' || saleValue == null) return null
  return storedAmountToCents(saleValue) - projectCostCents(project)
}

export function buildExpenseWrite(expense) {
  const description = String(expense?.description || '').trim()
  const amountCents = parseMoneyToCents(expense?.amount)
  const laborHours = roundLaborHours(expense?.laborHours)
  if (!description || amountCents === null || amountCents <= 0) throw new Error('Description and an amount greater than zero are required.')
  if (laborHours === null) throw new Error('Labor hours greater than zero are required.')
  return {
    description,
    amount: centsToAmount(amountCents),
    category: String(expense?.category || 'other'),
    laborHours,
  }
}

export function buildListingRequest(projectId, style, humorLevel, existingDescription = '', sellerBrief = '') {
  const id = String(projectId || '').trim()
  const normalizedStyle = String(style || '').trim().toLowerCase()
  if (!id) throw new Error('Project information is missing.')
  if (!STYLE_VALUES.has(normalizedStyle)) throw new Error('Choose a valid description style.')
  const brief = String(sellerBrief || '').trim().slice(0, 2000)
  if (!brief) throw new Error('Add buyer details before generating a description.')
  const description = String(existingDescription || '').trim().slice(0, 4000)
  const request = { projectId: id, style: normalizedStyle }
  if (normalizedStyle === 'funny') {
    const humor = String(humorLevel || 'balanced').trim().toLowerCase()
    if (!HUMOR_VALUES.has(humor)) throw new Error('Choose a valid humor level.')
    request.humorLevel = humor
  }
  if (description) request.existingDescription = description
  request.sellerBrief = brief
  return request
}

export function resolveNotesSave({ targetProjectId, currentProjectId, saveRequest, currentSaveRequest, savedEditVersion, currentEditVersion }) {
  const applyProject = targetProjectId === currentProjectId && saveRequest === currentSaveRequest
  return { applyProject, replaceDraft: applyProject && savedEditVersion === currentEditVersion }
}

export function mergeProjectGallery(project = {}) {
  const urls = [
    ...(Array.isArray(project.photos) ? project.photos : []),
    project.photo,
    project.beforePhoto || project.before_photo,
    project.afterPhoto || project.after_photo,
  ].map(url => typeof url === 'string' ? url.trim() : '').filter(Boolean)
  return [...new Set(urls)]
}

export const FREE_PROJECT_PHOTO_LIMIT = 5
export const PRO_PROJECT_PHOTO_LIMIT = 25

export function photoLimitForPlan(plan) {
  return plan === 'pro' ? PRO_PROJECT_PHOTO_LIMIT : FREE_PROJECT_PHOTO_LIMIT
}

export function buildProjectGalleryUpdate(project = {}, orderedUrls = []) {
  const photos = [...new Set(orderedUrls.map(url => typeof url === 'string' ? url.trim() : '').filter(Boolean))]
  const beforePhoto = project.beforePhoto || project.before_photo || null
  const afterPhoto = project.afterPhoto || project.after_photo || null
  return {
    photos,
    photo: photos[0] || null,
    beforePhoto: beforePhoto && photos.includes(beforePhoto) ? beforePhoto : null,
    afterPhoto: afterPhoto && photos.includes(afterPhoto) ? afterPhoto : null,
  }
}

export function projectPhotoRoles(project = {}, url) {
  const roles = []
  if (project.photo === url) roles.push('Main')
  if ((project.beforePhoto || project.before_photo) === url) roles.push('Before')
  if ((project.afterPhoto || project.after_photo) === url) roles.push('After')
  return roles
}

export function buildProjectTransferRequest(projectId, mutationId) {
  const id = String(projectId || '').trim()
  const mutation = String(mutationId || '').trim()
  if (!id || !mutation) throw new Error('Project and mutation IDs are required.')
  return { projectId: id, options: { serviceExpenseIds: [] }, mutationId: mutation }
}

export function buildMyStuffProjectDraft(item = {}) {
  return {
    title: String(item.name || item.title || '').trim(),
    category: item.projectCategory || item.category || 'other',
    notes: String(item.notes || '').trim(),
    vin: String(item.vin || '').trim(),
    modelNumber: String(item.modelNumber || item.model_number || item.model || '').trim(),
    serialNumber: String(item.serialNumber || item.serial_number || '').trim(),
  }
}
