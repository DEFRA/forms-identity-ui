export default /** @type {ServerRoute} */ ({
  method: 'GET',
  path: '/',
  handler(_, h) {
    return h.view('home')
  }
})

/**
 * @import { ServerRoute } from '@hapi/hapi'
 */
