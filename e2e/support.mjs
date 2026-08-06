/**
 * Support pieces for the sign-in e2e spec: a minimal RP (the role
 * forms-runner plays), the one-time-code capture, and the token exchange
 * the RP performs server-to-server.
 */
import http from 'node:http'
import { createRequire } from 'node:module'

import * as client from 'openid-client'

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
const PRIVATE_JWKS = process.env.EXAMPLE_RP_PRIVATE_JWKS

if (!PRIVATE_JWKS) {
  throw new Error(
    'EXAMPLE_RP_PRIVATE_JWKS must be set (this repo’s .env) — generate the pair with scripts/generate-client-keypair.mjs'
  )
}

const [PRIVATE_JWK] = JSON.parse(PRIVATE_JWKS).keys

/**
 * The client's signing key. The suite stands in for forms-runner, so it
 * holds the private half and the provider holds only the public one.
 */
async function clientKey() {
  return {
    key: await crypto.subtle.importKey(
      'jwk',
      PRIVATE_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    ),
    kid: PRIVATE_JWK.kid
  }
}

/** @type {client.Configuration | undefined} */
let discovered

/**
 * The provider as openid-client sees it. Driving the certified library
 * rather than hand-building requests is deliberate: it is what forms-runner
 * will use, so the suite exercises the same code path — including the client
 * authentication and ID token validation a hand-rolled call would skip.
 */
async function oidc() {
  discovered ??= await client.discovery(
    new URL(ISSUER),
    'runner',
    undefined,
    client.PrivateKeyJwt(await clientKey()),
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the local dev issuer is plain http, which is exactly the case this flag exists for
    { execute: [client.allowInsecureRequests] }
  )
  return discovered
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
      oidc()
        .then(async (config) => {
          const verifier = client.randomPKCECodeVerifier()
          const state = client.randomState()
          pending.set(state, verifier)

          const authUrl = client.buildAuthorizationUrl(config, {
            redirect_uri: `${RP}/callback`,
            scope: 'openid email',
            state,
            code_challenge: await client.calculatePKCECodeChallenge(verifier),
            code_challenge_method: 'S256'
          })

          res.writeHead(302, { Location: authUrl.href })
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
 * Exchanges the authorization code the way forms-runner will: openid-client
 * signs the client assertion, checks the state, and verifies the ID token's
 * signature and claims before returning it.
 * @param {string} callbackUrl - the RP callback URL carrying code and state
 * @param {Map<string, string>} pending - state -> PKCE verifier
 */
export async function exchangeCode(callbackUrl, pending) {
  const url = new URL(callbackUrl)
  const state = String(url.searchParams.get('state'))

  if (!url.searchParams.get('code')) {
    throw new Error(`no code on callback: ${callbackUrl}`)
  }

  return client.authorizationCodeGrant(await oidc(), url, {
    pkceCodeVerifier: pending.get(state),
    expectedState: state
  })
}

/**
 * The same exchange with no client authentication at all, to prove the
 * provider refuses it. Deliberately hand-built: openid-client will not send
 * a request it knows to be unauthenticated, which is the point of the test.
 * @param {string} callbackUrl - the RP callback URL carrying code and state
 * @param {Map<string, string>} pending - state -> PKCE verifier
 */
export async function exchangeCodeUnauthenticated(callbackUrl, pending) {
  const url = new URL(callbackUrl)
  const code = String(url.searchParams.get('code'))
  const state = String(url.searchParams.get('state'))
  const { token_endpoint: tokenEndpoint } = (await oidc()).serverMetadata()

  return fetch(String(tokenEndpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${RP}/callback`,
      code_verifier: String(pending.get(state)),
      client_id: 'runner'
    })
  })
}

/**
 * The ID token claims openid-client validated during the exchange
 * @param {client.TokenEndpointResponse & client.TokenEndpointResponseHelpers} tokens
 */
export function idTokenClaims(tokens) {
  const claims = tokens.claims()

  if (!claims) {
    throw new Error('token response carried no id_token')
  }

  return claims
}
