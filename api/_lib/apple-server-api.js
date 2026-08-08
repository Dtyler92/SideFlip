import { AppStoreServerAPIClient, Environment } from '@apple/app-store-server-library'
import { APPLE_BUNDLE_ID } from './apple-products.js'

export function createAppleServerApiClient(environmentName = process.env.APPLE_IAP_ENVIRONMENT) {
  const { APPLE_SERVER_API_PRIVATE_KEY: signingKey, APPLE_SERVER_API_KEY_ID: keyId, APPLE_SERVER_API_ISSUER_ID: issuerId } = process.env
  if (environmentName !== 'sandbox' && environmentName !== 'production') throw new Error('APPLE_IAP_ENVIRONMENT must be sandbox or production')
  if (!signingKey || !keyId || !issuerId) throw new Error('Apple Server API credentials are not configured')
  const environment = environmentName === 'production' ? Environment.PRODUCTION : Environment.SANDBOX
  return new AppStoreServerAPIClient(signingKey.replace(/\\n/g, '\n'), keyId, issuerId, APPLE_BUNDLE_ID, environment)
}
