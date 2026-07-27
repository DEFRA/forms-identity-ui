import {
  getEmail,
  getVerify,
  postComplete,
  postEmail
} from '~/src/server/routes/interaction/controller.js'

export default /** @type {ServerRoute[]} */ ([
  { method: 'GET', path: '/ui/interaction/{uid}', handler: getEmail },
  { method: 'POST', path: '/ui/interaction/{uid}/email', handler: postEmail },
  // GET, not POST: this is the "try again" return leg after the backend
  // rejects a code. Verification posts to the complete route below.
  { method: 'GET', path: '/ui/interaction/{uid}/verify', handler: getVerify },
  // Crumb-protected (unlike the pass-through OIDC proxy routes): the verify
  // form posts here with the crumb; after validation the handler forwards the
  // re-encoded form to the API's atomic verify+complete through the proxy.
  { method: 'POST', path: '/interaction/{uid}/complete', handler: postComplete }
])

/**
 * @import { ServerRoute } from '@hapi/hapi'
 */
