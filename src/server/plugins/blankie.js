import Blankie from 'blankie'

import { config } from '~/src/config/index.js'

/**
 * Content Security Policy for the service. Forms may only be submitted back
 * here; the sign-in pages that need more say so themselves.
 * @type {Record<string, boolean | string | string[]>}
 */
const basePolicy = {
  defaultSrc: ['self'],
  baseUri: ['none'],
  fontSrc: ['self', 'data:'],
  connectSrc: ['self'],
  scriptSrc: ['self'],
  styleSrc: ['self'],
  imgSrc: ['self', 'data:'],
  frameSrc: ['none'],
  // Same as blankie's own default, stated so that this object is the whole
  // policy and can be reused as a header value elsewhere
  workerSrc: ['self'],
  formAction: ['self'],
  frameAncestors: ['none'],
  objectSrc: ['none'],
  generateNonces: 'script'
}

// Everything else is a source expression and travels as written
const CSP_QUOTED_KEYWORDS = new Set(['self', 'none', 'unsafe-inline'])

/**
 * The base policy as a header value, for the responses blankie never sees:
 * oidc-provider writes protocol replies straight to the socket, so its
 * onPreResponse extension does not run for them. Built from the same object
 * as the plugin's own policy, so the two say the same thing. The nonce is
 * left out — blankie mints one per request for the pages it renders, and
 * these responses have no template to put it in.
 * @type {string}
 */
export const baseCspHeader = Object.entries(basePolicy)
  .filter(([directive]) => directive !== 'generateNonces')
  .map(([directive, sources]) => {
    const name = directive.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
    const values = /** @type {string[]} */ (sources).map((source) =>
      CSP_QUOTED_KEYWORDS.has(source) ? `'${source}'` : source
    )

    return `${name} ${values.join(' ')}`
  })
  .join(';')

const runnerRedirectOrigins = [
  ...new Set(
    config
      .get('oidc.runnerRedirectUris')
      .split(',')
      .map((uri) => new URL(uri).origin)
  )
]

/**
 * Policy for the pages whose form submission finishes the sign-in.
 * Chromium applies the submitting page's form-action to every redirect hop,
 * and completing a sign-in is exactly that: the POST 303s through the
 * provider back to the client's redirect_uri on another origin. Those
 * origins are registered configuration, so the policy allows precisely them
 * and nothing else — and only on these pages, so an injection bug anywhere
 * else in the service still has nowhere to send a form.
 *
 * This restates the whole policy on purpose: blankie replaces a route's
 * policy with the one it is given rather than merging into the default.
 * @type {Record<string, boolean | string | string[]>}
 */
export const signinFormCsp = {
  ...basePolicy,
  formAction: ['self', ...runnerRedirectOrigins]
}

/**
 * @satisfies {ServerRegisterPluginObject<Record<string, boolean | string | string[]>>}
 */
export default {
  plugin: Blankie,
  options: basePolicy
}

/**
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 */
