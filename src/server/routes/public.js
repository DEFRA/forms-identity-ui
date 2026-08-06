import { join } from 'node:path'

import { config } from '~/src/config/index.js'

/**
 * A file may only be cached forever if its name changes whenever its bytes
 * do. Webpack content-hashes the JS and CSS bundle names, but only for a
 * production build; images and fonts keep their plain names in every
 * environment, and govuk-frontend's own assets are copied across verbatim.
 * Anything unhashed therefore has to stay revalidatable, or a rebrand never
 * reaches a browser that has already been to the site.
 */
const bundleNamesCarryContentHash = config.get('isProduction')
const staticMaxAge = config.get('staticCacheMaxAge')
const oneYearSeconds = 31536000

const staticRoutes = [
  {
    from: '/javascripts/{path*}',
    to: join(config.get('publicDir'), 'javascripts'),
    immutable: bundleNamesCarryContentHash
  },
  {
    from: '/stylesheets/{path*}',
    to: join(config.get('publicDir'), 'stylesheets'),
    immutable: bundleNamesCarryContentHash
  },
  {
    from: '/assets/fonts/{path*}',
    to: join(config.get('publicDir'), 'assets/fonts'),
    immutable: false
  },
  {
    from: '/assets/{path*}',
    to: join(config.get('publicDir'), 'assets'),
    immutable: false
  }
]

/**
 * Root path prefixes the static routes own, read off the routes themselves
 * so the two can never drift apart. Shared with the logging and CSRF
 * plugins, which use them to keep asset traffic out of the request log and
 * to leave crumb cookies off responses that carry no form.
 */
export const STATIC_PATH_PREFIXES = [
  ...new Set(staticRoutes.map((route) => route.from.replace('{path*}', '')))
]

export default staticRoutes.map((options) => {
  return /** @type {ServerRoute} */ ({
    method: 'GET',
    path: options.from,
    options: {
      cache: {
        otherwise: options.immutable
          ? `public, max-age=${oneYearSeconds}, immutable`
          : `public, max-age=${staticMaxAge}`
      },
      handler: {
        directory: {
          path: options.to
        }
      }
    }
  })
})

/**
 * @import { ServerRoute } from '@hapi/hapi'
 */
