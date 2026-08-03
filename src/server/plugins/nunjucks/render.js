import { environment } from '~/src/server/plugins/nunjucks/environment.js'

/**
 * Render a Nunjucks view outside the hapi request lifecycle
 * (e.g. oidc-provider's renderError writes straight to the socket)
 * @param {string} viewPath
 * @param {{ context?: object }} [options]
 */
export function view(viewPath, options) {
  return environment.render(viewPath, options?.context)
}
