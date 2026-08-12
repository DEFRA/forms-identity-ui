/**
 * Support for the sign-in e2e spec. The relying party the browser talks to is
 * the real one in example/rp — Playwright starts it — so all that is left here
 * is reading the one-time code out of the store, and finding the token
 * endpoint for the test that calls it directly.
 */
import { createRequire } from 'node:module'

import 'dotenv/config'

// the same helper the running server uses, so the spec looks the record up
// under the key the server actually wrote
import { hashId } from '../src/server/common/helpers/hash-id.js'

// argon2/mongodb live in the API repo — resolve them from its node_modules
const apiRequire = createRequire(
  new URL('../../forms-identity-api/package.json', import.meta.url)
)
const argon2 = apiRequire('argon2')
const { MongoClient } = apiRequire('mongodb')

export const ISSUER = process.env.OIDC_ISSUER ?? 'http://localhost:3011'
export const RP = process.env.EXAMPLE_RP_URL ?? 'http://localhost:3901'
export const KNOWN_CODE = '123456'

const MONGO_URI =
  'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true'
const PURPOSE = 'SIGNIN_VERIFY_EMAIL'
/** Fifteen minutes in milliseconds, matching the API's own code lifetime */
const CODE_LIFETIME_MS = 900_000

/**
 * Replaces the stored code for the interaction with the known one. With a
 * dummy Notify key the email send fails loudly after the record is stored;
 * with a real key this simply replaces a deliverable code — either way the
 * spec knows the code without reading an inbox.
 * @param {string} uid - the interaction uid from the browser's URL
 * @param {string} email
 */
export async function captureCode(uid, email) {
  const mongo = await MongoClient.connect(MONGO_URI)
  // the UI keys the OTP record by a digest of the uid, so the browser's copy
  // has to be hashed before it will match
  const key = hashId(uid)

  try {
    const coll = mongo.db('forms-identity-api').collection('otps')
    const stored = await coll.findOne({ uid: key, purpose: PURPOSE })

    if (!stored) {
      throw new Error('otps record must exist (stored before the Notify call)')
    }
    if (stored.target !== email.toLowerCase()) {
      throw new Error(`stored target ${stored.target} != ${email}`)
    }
    if (!String(stored.codeHash).startsWith('$argon2')) {
      throw new Error('code must be stored hashed')
    }

    await coll.updateOne(
      { uid: key, purpose: PURPOSE },
      {
        $set: {
          codeHash: await argon2.hash(KNOWN_CODE),
          expireAt: new Date(Date.now() + CODE_LIFETIME_MS),
          attempts: 0,
          verified: false,
          consumed: false
        }
      }
    )
  } finally {
    await mongo.close()
  }
}

/**
 * The token endpoint, read from the discovery document rather than assumed,
 * for the test that posts to it directly
 * @returns {Promise<string>}
 */
export async function tokenEndpoint() {
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`)
  const { token_endpoint: endpoint } = await res.json()

  return endpoint
}
