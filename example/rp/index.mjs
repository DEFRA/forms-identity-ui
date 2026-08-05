/**
 * Example relying party for trying the sign-in journey in a browser without
 * forms-runner. The OIDC mechanics (discovery, PKCE, code exchange,
 * userinfo, logout URLs) come from openid-client — the certified RP library
 * — so this file is only routing and session bookkeeping. Never deployed:
 * lives outside src/, so the babel build and Docker image never include it.
 *
 * Started automatically by this repo's `npm run dev` (alongside the
 * service) on :3901; forms-identity-api must also be running (:3010, with
 * its mongo). Then open http://localhost:3901 and follow the links.
 */
import Hapi from '@hapi/hapi'
import * as client from 'openid-client'

import 'dotenv/config'

// eslint-disable-next-line no-restricted-imports -- runs under plain node (no ~ alias resolution)
import { errorPage, page, signedInPage, tokenSummary } from './views.mjs'

const ISSUER = process.env.EXAMPLE_RP_ISSUER ?? 'http://localhost:3011'
const PORT = Number(process.env.EXAMPLE_RP_PORT ?? 3901)
const BASE = `http://localhost:${PORT}`
const REDIRECT_URI = `${BASE}/callback`
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET

if (!CLIENT_SECRET) {
  throw new Error('OIDC_CLIENT_SECRET must be set (this repo’s .env)')
}

/** @type {client.Configuration | undefined} */
let oidcConfig

/** Discovers the provider once, lazily — the RP can boot before it */
async function discover() {
  oidcConfig ??= await client.discovery(
    new URL(ISSUER),
    'runner',
    CLIENT_SECRET,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the library deprecation-flags this to discourage it outside local development, which is exactly what this example is: the local dev issuer is plain http
    { execute: [client.allowInsecureRequests] }
  )
  return oidcConfig
}

/**
 * Single-user in-memory session — it's an example
 * @type {{ verifier?: string, state?: string, tokens?: client.TokenEndpointResponse, claims?: object, userinfo?: object, obtainedAt: number }}
 */
const session = { obtainedAt: 0 }

const server = Hapi.server({ port: PORT, host: 'localhost' })

server.route([
  {
    method: 'GET',
    path: '/',
    handler() {
      if (session.claims && session.tokens) {
        return signedInPage(
          session.claims,
          tokenSummary(session.tokens, session.obtainedAt),
          session.userinfo ?? {}
        )
      }
      return page('<p><a href="/login">Sign in</a></p>')
    }
  },
  {
    method: 'GET',
    path: '/login',
    async handler(_request, h) {
      const config = await discover()
      session.verifier = client.randomPKCECodeVerifier()
      session.state = client.randomState()

      const authUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: REDIRECT_URI,
        scope: 'openid email',
        state: session.state,
        code_challenge: await client.calculatePKCECodeChallenge(
          session.verifier
        ),
        code_challenge_method: 'S256'
      })
      return h.redirect(authUrl.href)
    }
  },
  {
    method: 'GET',
    path: '/callback',
    async handler(request, h) {
      const config = await discover()

      try {
        // validates state, exchanges the code as the confidential client
        // (basic auth) and verifies the ID token signature and claims
        const tokens = await client.authorizationCodeGrant(
          config,
          new URL(request.url.href),
          {
            pkceCodeVerifier: session.verifier,
            expectedState: session.state
          }
        )
        const claims = tokens.claims()

        session.tokens = tokens
        session.obtainedAt = Date.now()
        session.claims = claims
        session.userinfo = await client.fetchUserInfo(
          config,
          tokens.access_token,
          /** @type {string} */ (claims?.sub)
        )
      } catch (err) {
        return errorPage(String(err))
      }

      return h.redirect('/')
    }
  },
  {
    method: 'GET',
    path: '/logout',
    async handler(_request, h) {
      const config = await discover()
      const idToken = session.tokens?.id_token

      delete session.tokens
      delete session.claims
      delete session.userinfo

      const logoutUrl = client.buildEndSessionUrl(config, {
        ...(idToken && { id_token_hint: idToken }),
        client_id: 'runner'
      })
      return h.redirect(logoutUrl.href)
    }
  }
])

// hapi swallows handler errors into bare 500s unless subscribed — surface
// them, and log responses so the [rp] prefix shows traffic under npm run dev
server.events.on('response', (request) => {
  const statusCode =
    'statusCode' in request.response ? request.response.statusCode : '-'
  console.log(`${request.method.toUpperCase()} ${request.path} ${statusCode}`)
})
server.events.on({ name: 'request', channels: 'error' }, (_request, event) => {
  console.error(event.error)
})

await server.start()
console.log(`Example RP listening on ${BASE} (issuer ${ISSUER})`)
