import { proxyToIdentityApi } from '~/src/server/common/helpers/proxy.js'

/**
 * OIDC endpoints reverse-proxied verbatim to the private identity API. These
 * are RP/browser-driven OIDC redirects and token/userinfo requests — not our
 * own forms — so they are exempt from crumb CSRF validation (route-level
 * `crumb: false`; with the crumb plugin's payload validation left on, the
 * unparsed proxied POSTs would always be rejected).
 *
 * POST /interaction/{uid}/complete is intentionally NOT in this list: the
 * browser posts the code there to the backend's atomic verify+complete, so it
 * is an explicit crumb-protected route (see routes/interaction) that forwards
 * the re-encoded form through the same hardened proxy path after validation.
 */
const PROXIED = /** @type {{ method: 'GET' | '*', path: string }[]} */ ([
  { method: 'GET', path: '/.well-known/{any*}' },
  { method: '*', path: '/auth/{any*}' },
  { method: '*', path: '/token' },
  { method: '*', path: '/me' },
  { method: 'GET', path: '/jwks' },
  { method: '*', path: '/session/{any*}' },
  { method: 'GET', path: '/interaction/{uid}' }
])

/**
 * Hardened reverse proxy exposing the private identity API's OIDC endpoints
 * on this public façade
 * @satisfies {ServerRegisterPluginObject<void>}
 */
export default {
  plugin: {
    name: 'oidc-proxy',
    /**
     * @param {Server} server
     */
    register(server) {
      for (const route of PROXIED) {
        server.route({
          method: route.method,
          path: route.path,
          options: {
            plugins: { crumb: false },
            // GET/HEAD cannot carry payload settings in hapi
            ...(route.method === 'GET'
              ? {}
              : { payload: { parse: false, output: 'data' } })
          },
          handler: (request, h) => proxyToIdentityApi(request, h)
        })
      }
    }
  }
}

/**
 * @import { Server, ServerRegisterPluginObject } from '@hapi/hapi'
 */
