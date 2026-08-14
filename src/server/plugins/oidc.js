import Provider from 'oidc-provider'

import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { makeHttpAdapter } from '~/src/server/oidc/http-adapter.js'
import { buildProviderConfig } from '~/src/server/oidc/provider-config.js'

const OIDC_ISSUER = config.get('oidc.issuer')
const { host: ISSUER_HOST, protocol: ISSUER_PROTOCOL } = new URL(OIDC_ISSUER)
const ISSUER_PROTO = ISSUER_PROTOCOL.replace(':', '')

// An ignored host is worth seeing in the logs, at a length that cannot flood
// them — the value is caller-supplied and only its identity matters
const LOGGED_HOST_MAX_LENGTH = 100

/**
 * Paths owned by oidc-provider. Mounted explicitly (no catch-all) so
 * unknown URLs still fall through to the GDS 404 page. Crumb is disabled on
 * every protocol route: CSRF there is handled by OIDC itself (state/PKCE at
 * the RP, client auth at the token endpoint) and /token is a server-to-server
 * POST that could never carry a crumb. GET routes must not set payload
 * options, so methods are listed explicitly rather than via '*'.
 * @type {{ methods: RouteDefMethods[], path: string, payload: boolean }[]}
 */
const PROTOCOL_ROUTES = [
  { methods: ['GET'], path: '/auth', payload: false },
  { methods: ['POST'], path: '/auth', payload: true },
  { methods: ['GET'], path: '/auth/{p*}', payload: false },
  { methods: ['POST'], path: '/token', payload: true },
  { methods: ['GET'], path: '/me', payload: false },
  { methods: ['POST'], path: '/me', payload: true },
  { methods: ['GET'], path: '/jwks', payload: false },
  { methods: ['GET'], path: '/.well-known/{p*}', payload: false },
  { methods: ['GET'], path: '/session/{p*}', payload: false },
  { methods: ['POST'], path: '/session/{p*}', payload: true }
]

/**
 * Fixes the origin the provider builds its URLs from. oidc-provider derives
 * every advertised endpoint, form action and redirect from the incoming
 * request, so the public origin is stated here from OIDC_ISSUER rather than
 * read from the caller: the URLs then match the issuer in every environment,
 * and a forged X-Forwarded-Host has nothing left to influence.
 *
 * The load balancer overwrites these headers on every real request, so a
 * disagreement means either it has stopped doing so or someone is probing.
 * Both are worth knowing about and neither changes the URLs, so the value is
 * logged rather than refused — refusing would turn a proxy misconfiguration
 * into an outage for anything that reaches us under another name.
 * @param {IncomingMessage} req
 */
function pinOrigin(req) {
  const claimed = req.headers['x-forwarded-host']

  if (claimed !== undefined && claimed !== ISSUER_HOST) {
    logger.warn(
      `[forwardedHostIgnored] X-Forwarded-Host "${String(claimed).slice(0, LOGGED_HOST_MAX_LENGTH)}" does not match the issuer host "${ISSUER_HOST}" - building URLs from the issuer`
    )
  }

  req.headers['x-forwarded-host'] = ISSUER_HOST
  req.headers['x-forwarded-proto'] = ISSUER_PROTO
}

/**
 * The headers hapi puts on every response it routes itself, restated for the
 * ones it never sees. oidc-provider sets no security headers of its own and
 * says a helmet is the deployment's job; on hapi the framework's own helmet
 * cannot reach these, because the documented mount hands the provider the raw
 * socket and abandons the request, leaving `routes.security` and blankie out
 * of it. This is what stops the sign-out confirmation page from being framed,
 * and it is the only policy the provider's error page has.
 *
 * The values are stated because neither source can be read back: hapi builds
 * them inside its own response path, and blankie keeps its policy builder
 * module-private. `oidc.test.js` compares what a protocol route and a routed
 * page actually emit, header for header, so the two stay one baseline.
 *
 * The CSP is the base policy from plugins/blankie.js without the per-page
 * script nonce — blankie mints one for the templates it renders, and these
 * responses have none.
 * @type {Record<string, string>}
 */
const SECURITY_HEADERS = {
  'content-security-policy':
    "base-uri 'none';connect-src 'self';default-src 'self';font-src 'self' data:;form-action 'self';frame-ancestors 'none';frame-src 'none';img-src 'self' data:;object-src 'none';script-src 'self';style-src 'self';worker-src 'self'",
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-download-options': 'noopen',
  'x-frame-options': 'DENY',
  'x-xss-protection': '1; mode=block'
}

/**
 * Runs node-oidc-provider inside this service, so its cookies are
 * first-party. Persistence is the HTTP adapter against forms-identity-api.
 * @satisfies {ServerRegisterPluginObject<void>}
 */
export default {
  plugin: {
    name: 'oidc',
    /**
     * @param {Server} server
     */
    register(server) {
      const provider = new Provider(
        OIDC_ISSUER,
        buildProviderConfig(makeHttpAdapter())
      )
      // Required: trusts the X-Forwarded-* headers so the provider builds
      // https:// URLs and secure cookies. Removing this breaks every deployed
      // environment. What it trusts is what pinOrigin just wrote.
      provider.proxy = true

      // The provider turns internal faults into a bare `server_error` for the
      // client, so without this the cause never reaches the logs — an adapter
      // or persistence failure would surface only as an opaque 500.
      provider.on('server_error', (_ctx, err) => {
        logger.error(err, '[oidcServerError] provider raised a server error')
      })

      // Set before the provider routes the request, so it can read the policy
      // back and extend it: it appends a script hash to the CSP on the pages
      // that carry an inline script
      provider.use(async (ctx, next) => {
        ctx.set(SECURITY_HEADERS)
        await next()
      })

      server.app.oidcProvider = provider

      const callback = provider.callback()

      /**
       * Bridges a hapi request to oidc-provider's node http callback. The
       * provider writes the response straight to the raw socket, so the
       * handler must tell hapi not to respond as well: it waits for the
       * socket to finish and returns h.abandon. Without this, hapi would
       * send its own (second) response and corrupt every protocol reply.
       * @param {Request} request
       * @param {ResponseToolkit} h
       */
      function bridge(request, h) {
        return new Promise((resolve) => {
          const { req, res } = request.raw
          pinOrigin(req)
          const done = () => {
            resolve(h.abandon)
          }
          res.on('finish', done)
          res.on('error', done)
          req.on('aborted', done)
          callback(req, res).catch(done)
        })
      }

      server.route(
        PROTOCOL_ROUTES.map(({ methods, path, payload }) => ({
          method: methods,
          path,
          options: {
            plugins: { crumb: false },
            ...(payload && {
              payload: {
                output: /** @type {const} */ ('stream'),
                parse: false
              }
            })
          },
          handler: bridge
        }))
      )
    }
  }
}

/**
 * @import { IncomingMessage } from 'node:http'
 * @import { Request, ResponseToolkit, RouteDefMethods, Server, ServerRegisterPluginObject } from '@hapi/hapi'
 */
