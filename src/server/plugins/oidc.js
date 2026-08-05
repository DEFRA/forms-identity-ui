import Provider from 'oidc-provider'

import { config } from '~/src/config/index.js'
import { makeHttpAdapter } from '~/src/server/oidc/http-adapter.js'
import { buildProviderConfig } from '~/src/server/oidc/provider-config.js'

const OIDC_ISSUER = config.get('oidc.issuer')

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
      // oidc-provider builds absolute URLs (issuer, redirects) and decides
      // cookie security from what it thinks the request origin is. Behind
      // the platform's TLS-terminating load balancer that must come from the
      // X-Forwarded-* headers, which the provider (koa-based) only trusts
      // with this flag — hapi apps don't need an equivalent because they
      // never construct absolute URLs from the request.
      provider.proxy = true

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
 * @import { Request, ResponseToolkit, RouteDefMethods, Server, ServerRegisterPluginObject } from '@hapi/hapi'
 */
