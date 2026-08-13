import Provider from 'oidc-provider'

import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { rawSecurityHeaders } from '~/src/server/common/helpers/security-headers.js'
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
 * Gives a protocol response the same headers a hapi-routed one gets. The
 * provider writes to the socket itself and hapi is told to abandon the
 * request, so `routes.security` and blankie both stay out of it — the
 * headers are put on the raw response here instead, before the provider is
 * handed the socket.
 *
 * This is what stops the logout confirmation page from being framed, and it
 * is the only policy the provider's error page has.
 *
 * Applied twice, and only where a header is absent. Once now, so the
 * provider can read the policy back and extend it (it appends a script hash
 * to the CSP on the pages that carry an inline script), and once at write
 * time to restore whatever is missing by then: koa empties the response of
 * every header when it handles an unexpected error, which is exactly the
 * response that most needs a policy behind it.
 * @param {ServerResponse} res
 */
function applySecurityHeaders(res) {
  const setBaseline = () => {
    for (const [name, value] of Object.entries(rawSecurityHeaders)) {
      if (!res.hasHeader(name)) {
        res.setHeader(name, value)
      }
    }
  }

  setBaseline()

  /** @type {ServerResponse['writeHead']} */
  const writeHead = res.writeHead.bind(res)

  res.writeHead = /** @type {ServerResponse['writeHead']} */ (
    (/** @type {Parameters<ServerResponse['writeHead']>} */ ...args) => {
      setBaseline()

      return writeHead(...args)
    }
  )
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
          applySecurityHeaders(res)
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
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { Request, ResponseToolkit, RouteDefMethods, Server, ServerRegisterPluginObject } from '@hapi/hapi'
 */
