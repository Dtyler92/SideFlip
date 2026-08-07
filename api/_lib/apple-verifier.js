import { Environment, SignedDataVerifier } from '@apple/app-store-server-library'
import { APPLE_BUNDLE_ID } from './apple-products.js'

function rootCertificates() {
  const roots = (process.env.APPLE_ROOT_CERTIFICATES_BASE64 || '').split(',').filter(Boolean).map(value => Buffer.from(value, 'base64'))
  if (!roots.length) throw new Error('Missing APPLE_ROOT_CERTIFICATES_BASE64')
  return roots
}

function verifierEnvironment() {
  if (process.env.APPLE_IAP_ENVIRONMENT === 'sandbox') return Environment.SANDBOX
  if (process.env.APPLE_IAP_ENVIRONMENT === 'production') return Environment.PRODUCTION
  throw new Error('APPLE_IAP_ENVIRONMENT must be sandbox or production')
}

function productionAppAppleId(environment) {
  if (environment !== Environment.PRODUCTION) return undefined
  const value = process.env.APPLE_APP_APPLE_ID || ''
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Missing or invalid APPLE_APP_APPLE_ID')
  return Number(value)
}

export function createAppleVerifier() {
  const environment = verifierEnvironment()
  return new SignedDataVerifier(rootCertificates(), true, environment, APPLE_BUNDLE_ID, productionAppAppleId(environment))
}
