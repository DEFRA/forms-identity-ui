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
  formAction: ['self'],
  frameAncestors: ['none'],
  objectSrc: ['none'],
  generateNonces: 'script'
}

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
