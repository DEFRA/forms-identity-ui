import { baseCspHeader } from '~/src/server/plugins/blankie.js'

const HSTS_MAX_AGE_SECONDS = 31536000

/**
 * The security headers hapi adds to every response it routes itself.
 * @satisfies {RouteOptionsSecureObject}
 */
export const routeSecurity = {
  hsts: {
    maxAge: HSTS_MAX_AGE_SECONDS,
    includeSubDomains: true,
    preload: false
  },
  xss: 'enabled',
  noSniff: true,
  xframe: true
}

/**
 * The same baseline as raw header names and values, for the responses that
 * leave through the socket instead of hapi's response pipeline — everything
 * oidc-provider owns. Written out because hapi builds these values inside
 * its own response path; `plugins/oidc.test.js` compares what a protocol
 * route and a hapi route actually emit, so the two stay one baseline.
 * @type {Record<string, string>}
 */
export const rawSecurityHeaders = {
  'strict-transport-security': `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
  'x-frame-options': 'DENY',
  'x-xss-protection': '1; mode=block',
  'x-content-type-options': 'nosniff',
  'content-security-policy': baseCspHeader
}

/**
 * @import { RouteOptionsSecureObject } from '@hapi/hapi'
 */
