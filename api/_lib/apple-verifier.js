import { Environment, SignedDataVerifier } from '@apple/app-store-server-library'
import { APPLE_BUNDLE_ID } from './apple-products.js'

function rootCertificates() {
  const roots = (process.env.APPLE_ROOT_CERTIFICATES_BASE64 || '').split(',').filter(Boolean).map(value => Buffer.from(value, 'base64'))
  if (!roots.length) throw new Error('Missing APPLE_ROOT_CERTIFICATES_BASE64')
  return roots
}

function verifierEnvironment(environmentName = process.env.APPLE_IAP_ENVIRONMENT) {
  if (environmentName === 'sandbox') return Environment.SANDBOX
  if (environmentName === 'production') return Environment.PRODUCTION
  throw new Error('APPLE_IAP_ENVIRONMENT must be sandbox or production')
}

function productionAppAppleId(environment) {
  if (environment !== Environment.PRODUCTION) return undefined
  const value = process.env.APPLE_APP_APPLE_ID || ''
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Missing or invalid APPLE_APP_APPLE_ID')
  return Number(value)
}

export function createAppleVerifier(environmentName) {
  const environment = verifierEnvironment(environmentName)
  return new SignedDataVerifier(rootCertificates(), true, environment, APPLE_BUNDLE_ID, productionAppAppleId(environment))
}

export function appleVerificationEnvironments(configuredEnvironment = process.env.APPLE_IAP_ENVIRONMENT) {
  if (configuredEnvironment !== 'sandbox' && configuredEnvironment !== 'production') {
    throw new Error('APPLE_IAP_ENVIRONMENT must be sandbox or production')
  }
  return configuredEnvironment === 'sandbox' ? ['sandbox', 'production'] : ['production', 'sandbox']
}

export async function verifyAppleSignedData(signedData, kind = 'transaction') {
  const environments = appleVerificationEnvironments()
  let lastError
  for (const environmentName of environments) {
    try {
      const verifier = createAppleVerifier(environmentName)
      const decoded = kind === 'notification'
        ? await verifier.verifyAndDecodeNotification(signedData)
        : await verifier.verifyAndDecodeTransaction(signedData)
      return { verifier, decoded, environmentName }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('Apple signed-data verification failed')
}
