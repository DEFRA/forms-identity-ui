/**
 * Example relying party for trying the sign-in journey in a browser without
 * forms-runner. It does what any OIDC RP does: /login starts an
 * authorization-code + PKCE flow, /callback exchanges the code as the
 * confidential `runner` client and fetches userinfo, /logout ends the
 * provider session. Never deployed: lives outside src/, so the babel build
 * and Docker image never include it.
 *
 * Started automatically by this repo's `npm run dev` (alongside the
 * service) on :3901; forms-identity-api must also be running (:3010, with
 * its mongo). Then open http://localhost:3901 and follow the links.
 */
import crypto from 'node:crypto'

import Hapi from '@hapi/hapi'

import 'dotenv/config'

const ISSUER = process.env.EXAMPLE_RP_ISSUER ?? 'http://localhost:3011'
const PORT = Number(process.env.EXAMPLE_RP_PORT ?? 3901)
const BASE = `http://localhost:${PORT}`
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET

if (!CLIENT_SECRET) {
  throw new Error('OIDC_CLIENT_SECRET must be set (this repo’s .env)')
}

/** @type {Record<string, string> | undefined} */
let discovery

async function disco() {
  if (!discovery) {
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`)
    discovery = /** @type {Record<string, string>} */ (await res.json())
  }
  return discovery
}

/**
 * Single-user in-memory session — it's an example
 * @type {{ verifier?: string, state?: string, tokens?: Record<string, string>, claims?: object, userinfo?: object, obtainedAt: number }}
 */
const session = { obtainedAt: 0 }

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/** @param {string} body */
function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example RP</title></head><body><h1>Example RP</h1>${body}</body></html>`
}

/**
 * What the token response gives an RP. The access token is opaque by design
 * (not a JWT) — the decodable payload lives in the ID token — so the useful
 * parts here are the grant metadata and computed expiry.
 */
function tokenSummary() {
  const tokens = session.tokens ?? {}
  const expiresIn = Number(tokens.expires_in)
  /** @param {string | undefined} value */
  const truncate = (value) =>
    value ? `${value.slice(0, 16)}… (${value.length} chars)` : undefined
  return {
    token_type: tokens.token_type,
    scope: tokens.scope,
    expires_in: tokens.expires_in,
    expires_at: Number.isFinite(expiresIn)
      ? new Date(session.obtainedAt + expiresIn * 1000).toISOString()
      : undefined,
    access_token: truncate(tokens.access_token),
    id_token: truncate(tokens.id_token)
  }
}

const server = Hapi.server({ port: PORT, host: 'localhost' })

server.route([
  {
    method: 'GET',
    path: '/',
    handler() {
      if (session.claims) {
        return page(`
          <p>Signed in.</p>
          <h2>ID token claims</h2>
          <pre>${escapeHtml(JSON.stringify(session.claims, null, 2))}</pre>
          <h2>Token response</h2>
          <pre>${escapeHtml(JSON.stringify(tokenSummary(), null, 2))}</pre>
          <h2>Userinfo (fetched with the access token)</h2>
          <pre>${escapeHtml(JSON.stringify(session.userinfo, null, 2))}</pre>
          <p><a href="/login">Sign in again</a> <a href="/logout">Sign out</a></p>`)
      }
      return page('<p><a href="/login">Sign in</a></p>')
    }
  },
  {
    method: 'GET',
    path: '/login',
    async handler(_request, h) {
      const d = await disco()
      session.verifier = crypto.randomBytes(32).toString('base64url')
      session.state = crypto.randomBytes(8).toString('base64url')
      const challenge = crypto
        .createHash('sha256')
        .update(session.verifier)
        .digest()
        .toString('base64url')
      const authUrl =
        `${d.authorization_endpoint}?` +
        String(
          new URLSearchParams({
            client_id: 'runner',
            response_type: 'code',
            scope: 'openid email',
            redirect_uri: `${BASE}/callback`,
            state: session.state,
            code_challenge: challenge,
            code_challenge_method: 'S256'
          })
        )
      return h.redirect(authUrl)
    }
  },
  {
    method: 'GET',
    path: '/callback',
    async handler(request, h) {
      const { code, state, error } =
        /** @type {{ code?: string, state?: string, error?: string }} */ (
          request.query
        )
      if (error) {
        return page(
          `<p>Provider returned an error:</p><pre>${escapeHtml(error)}</pre>`
        )
      }
      if (!code || state !== session.state || !session.verifier) {
        return page(
          '<p>Missing code or state mismatch — start again at <a href="/">home</a>.</p>'
        )
      }
      const d = await disco()
      const tokenRes = await fetch(d.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization:
            'Basic ' + Buffer.from(`runner:${CLIENT_SECRET}`).toString('base64')
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${BASE}/callback`,
          code_verifier: session.verifier
        })
      })
      const tokens = /** @type {Record<string, string>} */ (
        await tokenRes.json()
      )
      if (!tokens.id_token) {
        return page(
          `<p>Token exchange failed:</p><pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>`
        )
      }
      session.tokens = tokens
      session.obtainedAt = Date.now()
      session.claims = /** @type {object} */ (
        JSON.parse(
          Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()
        )
      )
      const userinfoRes = await fetch(`${ISSUER}/me`, {
        headers: { authorization: `Bearer ${tokens.access_token}` }
      })
      session.userinfo = /** @type {object} */ (await userinfoRes.json())
      return h.redirect('/')
    }
  },
  {
    method: 'GET',
    path: '/logout',
    async handler(_request, h) {
      const d = await disco()
      const idToken = session.tokens?.id_token
      delete session.tokens
      delete session.claims
      delete session.userinfo
      const logoutUrl =
        `${d.end_session_endpoint}?` +
        String(
          new URLSearchParams({
            ...(idToken && { id_token_hint: idToken }),
            client_id: 'runner'
          })
        )
      return h.redirect(logoutUrl)
    }
  }
])

await server.start()
console.log(`Example RP listening on ${BASE} (issuer ${ISSUER})`)
