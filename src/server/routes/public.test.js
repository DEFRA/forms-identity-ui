/**
 * Builds the static routes as they would be in a given environment — the
 * cache policy depends on whether webpack content-hashed the filenames,
 * which only happens in a production build
 * @param {string} nodeEnv
 * @returns {Promise<ServerRoute[]>}
 */
async function loadRoutes(nodeEnv) {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = nodeEnv
  jest.resetModules()

  try {
    return (await import('~/src/server/routes/public.js')).default
  } finally {
    process.env.NODE_ENV = previous
    jest.resetModules()
  }
}

/**
 * @param {ServerRoute[]} routes
 * @param {string} path
 */
function cacheHeader(routes, path) {
  const route = routes.find((candidate) => candidate.path === path)
  const options = /** @type {{ cache: { otherwise: string } }} */ (
    route?.options
  )
  return options.cache.otherwise
}

describe('static asset caching', () => {
  // webpack emits these as `assets/images/[name][ext]` and
  // `assets/fonts/[name][ext]` in every environment, so the URL alone can
  // never tell a cache that the bytes behind it changed
  it.each(['/assets/{path*}', '/assets/fonts/{path*}'])(
    'never tells caches to keep %s forever',
    async (path) => {
      const routes = await loadRoutes('production')

      expect(cacheHeader(routes, path)).not.toContain('immutable')
    }
  )

  it.each(['/javascripts/{path*}', '/stylesheets/{path*}'])(
    'lets caches keep the content-hashed %s forever in production',
    async (path) => {
      const routes = await loadRoutes('production')

      expect(cacheHeader(routes, path)).toContain('immutable')
    }
  )

  it.each(['/javascripts/{path*}', '/stylesheets/{path*}'])(
    'does not mark %s immutable outside production, where it is unhashed',
    async (path) => {
      const routes = await loadRoutes('test')

      expect(cacheHeader(routes, path)).not.toContain('immutable')
    }
  )
})

/**
 * @import { ServerRoute } from '@hapi/hapi'
 */
