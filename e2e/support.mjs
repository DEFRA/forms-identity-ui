/**
 * Support pieces for the sign-in e2e spec: a minimal RP (the role
 * forms-runner plays), the one-time-code capture, and the token exchange
 * the RP performs server-to-server.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'

import 'dotenv/config'

// argon2/mongodb live in the API repo — resolve them from its node_modules
const apiRequire = createRequire(
  new URL('../../forms-identity-api/package.json', import.meta.url)
)
const argon2 = apiRequire('argon2')
const { MongoClient } = apiRequire('mongodb')

export const ISSUER = 'http://localhost:3011'
export const RP_PORT = Number(process.env.E2E_RP_PORT ?? 3902)
export const RP = `http://localhost:${RP_PORT}`
export const KNOWN_CODE = '123456'

const MONGO_URI =
  'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true'
const PURPOSE = 'SIGNIN_VERIFY_EMAIL'
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET

if (!CLIENT_SECRET) {
  throw new Error('OIDC_CLIENT_SECRET must be set (this repo’s .env)')
}

/** @type {Record<string, string> | undefined} */
let discovery

async function disco() {
  discovery ??= /** @type {Record<string, string>} */ (
    await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()
  )
  return discovery
}

/**
 * Starts the RP the browser talks to: /login begins an authorization-code +
 * PKCE flow, /callback just renders a marker page (the spec reads the code
 * from the URL). Returns a close function.
 */
export async function startRp() {
  /** @type {Map<string, string>} */
  const pending = new Map()

  const rp = http.createServer((request, res) => {
    const url = new URL(request.url ?? '/', RP)

    if (url.pathname === '/login') {
      disco()
        .then((d) => {
          const verifier = crypto.randomBytes(32).toString('base64url')
          const challenge = crypto
            .createHash('sha256')
            .update(verifier)
            .digest()
            .toString('base64url')
          const state = crypto.randomBytes(8).toString('base64url')
          pending.set(state, verifier)

          const authUrl =
            `${d.authorization_endpoint}?` +
            String(
              new URLSearchParams({
                client_id: 'runner',
                response_type: 'code',
                scope: 'openid email',
                redirect_uri: `${RP}/callback`,
                state,
                code_challenge: challenge,
                code_challenge_method: 'S256'
              })
            )
          res.writeHead(302, { Location: authUrl })
          res.end()
        })
        .catch((err) => {
          res.writeHead(500)
          res.end(String(err))
        })
      return
    }

    if (url.pathname === '/callback') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<h1>RP callback</h1>')
      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve, reject) => {
    rp.on('error', reject) // e.g. EADDRINUSE
    rp.listen(RP_PORT, () => {
      resolve(undefined)
    })
  })

  return {
    pending,
    close: () =>
      new Promise((resolve) => {
        rp.close(() => {
          resolve(undefined)
        })
      })
  }
}

/**
 * Replaces the stored code for the interaction with the known one. With a
 * dummy Notify key the email send fails loudly after the record is stored;
 * with a real key this simply replaces a deliverable code — either way the
 * spec knows the code without reading an inbox.
 * @param {string} uid
 * @param {string} email
 */
export async function captureCode(uid, email) {
  const mongo = await MongoClient.connect(MONGO_URI)

  try {
    const coll = mongo.db('forms-identity-api').collection('otps')
    const stored = await coll.findOne({ uid, purpose: PURPOSE })

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
      { uid, purpose: PURPOSE },
      {
        $set: {
          codeHash: await argon2.hash(KNOWN_CODE),
          expireAt: new Date(Date.now() + 900_000),
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
 * Exchanges the authorization code as the confidential client (or without
 * auth, to prove the provider refuses public exchanges)
 * @param {string} callbackUrl - the RP callback URL carrying code and state
 * @param {Map<string, string>} pending - state -> PKCE verifier
 * @param {{ auth?: boolean }} [options]
 */
export async function exchangeCode(callbackUrl, pending, { auth = true } = {}) {
  const url = new URL(callbackUrl)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')

  if (!code) {
    throw new Error(`no code on callback: ${callbackUrl}`)
  }

  const d = await disco()
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }

  if (auth) {
    headers.authorization =
      'Basic ' + Buffer.from(`runner:${CLIENT_SECRET}`).toString('base64')
  }

  return fetch(d.token_endpoint, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${RP}/callback`,
      code_verifier: String(pending.get(String(state))),
      ...(auth ? {} : { client_id: 'runner' })
    })
  })
}

/**
 * The decoded ID token claims from a token response
 * @param {{ id_token: string }} tokens
 * @returns {Record<string, string>}
 */
export function idTokenClaims(tokens) {
  return /** @type {Record<string, string>} */ (
    JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()
    )
  )
}
