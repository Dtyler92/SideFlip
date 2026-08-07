export const APPLE_BUNDLE_ID = 'com.sideflip.app'
export const APPLE_PRO_PRODUCT_IDS = new Set(['com.sideflip.app.pro.monthly', 'com.sideflip.app.pro.annual'])

export function isSideFlipProProduct(productId) {
  return typeof productId === 'string' && APPLE_PRO_PRODUCT_IDS.has(productId)
}
