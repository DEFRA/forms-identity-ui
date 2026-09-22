import { setLanguage } from '~/src/server/i18n/index.js'

export default /** @type {ServerRoute} */ ({
  method: 'GET',
  path: '/',
  handler(request, h) {
    setLanguage(request)

    return h.view('home')
  }
})

/**
 * @import { ServerRoute } from '@hapi/hapi'
 */
