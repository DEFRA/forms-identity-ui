import Blankie from 'blankie'

import { config } from '~/src/config/index.js'

/**
 * Chromium applies the submitting page's form-action to every redirect hop
 * of the submission — and completing a sign-in is exactly that: the final
 * interaction POST 303s through the provider back to the client's
 * redirect_uri on another origin. Those origins are registered
 * configuration, so the policy allows precisely them and nothing else.
 */
const runnerRedirectOrigins = [
  ...new Set(
    config
      .get('oidc.runnerRedirectUris')
      .split(',')
      .map((uri) => new URL(uri).origin)
  )
]

/**
 * Content Security Policy using blankie
 * @satisfies {ServerRegisterPluginObject<Record<string, boolean | string | string[]>>}
 */
export default {
  plugin: Blankie,
  options: {
    defaultSrc: ['self'],
    baseUri: ['none'],
    fontSrc: ['self', 'data:'],
    connectSrc: ['self'],
    scriptSrc: ['self'],
    styleSrc: ['self'],
    imgSrc: ['self', 'data:'],
    frameSrc: ['none'],
    formAction: ['self', ...runnerRedirectOrigins],
    frameAncestors: ['none'],
    objectSrc: ['none'],
    generateNonces: 'script'
  }
}

/**
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 */
