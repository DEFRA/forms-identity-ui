import { StatusCodes } from 'http-status-codes'
import Joi from 'joi'

import { config } from '~/src/config/index.js'
import { proxyToIdentityApi } from '~/src/server/common/helpers/proxy.js'

const EMAIL_PAGE_TITLE = 'Sign in to save your progress'
const VERIFY_PAGE_TITLE = 'Enter your security code'

const SEND_FAILED_MESSAGE =
  'Sorry, there was a problem sending your code. Try again.'
const INVALID_CODE_MESSAGE = 'The security code you entered is not correct'

const emailSchema = Joi.string()
  .trim()
  .required()
  .email({ tlds: { allow: false } })
  .messages({
    'any.required': 'Enter an email address',
    'string.empty': 'Enter an email address',
    'string.email':
      'Enter an email address in the correct format, like name@example.com'
  })

/**
 * Render the email entry page, optionally with a GDS error summary and
 * field-level error
 * @param {ResponseToolkit} h
 * @param {string} uid - interaction uid
 * @param {{ email?: string, errorText?: string, status?: number }} [state]
 */
function emailView(h, uid, { email, errorText, status } = {}) {
  const response = h.view('interaction/email', {
    pageTitle: errorText ? `Error: ${EMAIL_PAGE_TITLE}` : EMAIL_PAGE_TITLE,
    uid,
    email,
    errors: errorText ? [{ text: errorText, href: '#email' }] : undefined,
    emailError: errorText ? { text: errorText } : undefined
  })
  return status ? response.code(status) : response
}

/**
 * Render the security code page, optionally with the invalid-code error
 * @param {ResponseToolkit} h
 * @param {string} uid - interaction uid
 * @param {string} email - the address the code was sent to
 * @param {{ invalidCode?: boolean }} [state]
 */
function verifyView(h, uid, email, { invalidCode } = {}) {
  return h.view('interaction/verify', {
    pageTitle: invalidCode ? `Error: ${VERIFY_PAGE_TITLE}` : VERIFY_PAGE_TITLE,
    uid,
    email,
    errors: invalidCode
      ? [{ text: INVALID_CODE_MESSAGE, href: '#code' }]
      : undefined,
    codeError: invalidCode ? { text: INVALID_CODE_MESSAGE } : undefined
  })
}

/**
 * GET /ui/interaction/{uid} — the email entry page. Rendering is purely
 * client-side of the API; the uid is only echoed into the form actions.
 * @param {Request} request
 * @param {ResponseToolkit} h
 */
export function getEmail(request, h) {
  return emailView(h, /** @type {string} */ (request.params.uid))
}

/**
 * POST /ui/interaction/{uid}/email (crumb-protected) — validate the address,
 * then ask the identity API server-to-server to send a security code. The
 * code is never returned to the browser: it only ever reaches the citizen's
 * inbox (via GOV.UK Notify on the API side).
 * @param {Request} request
 * @param {ResponseToolkit} h
 */
export async function postEmail(request, h) {
  const uid = /** @type {string} */ (request.params.uid)
  const payload = /** @type {{ email?: string }} */ (request.payload)

  const { error, value } = emailSchema.validate(payload.email)
  if (error) {
    return emailView(h, uid, {
      email: payload.email,
      errorText: error.message,
      status: StatusCodes.BAD_REQUEST.valueOf()
    })
  }
  const email = /** @type {string} */ (value)

  /** @type {Response | undefined} */
  let response
  try {
    response = await fetch(`${config.get('identityApi.url')}/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid, email }),
      signal: AbortSignal.timeout(config.get('identityApi.timeoutMs'))
    })
  } catch {
    response = undefined
  }

  if (!response?.ok) {
    return emailView(h, uid, {
      email,
      errorText: SEND_FAILED_MESSAGE,
      status: StatusCodes.BAD_GATEWAY.valueOf()
    })
  }

  return verifyView(h, uid, email)
}

/**
 * GET /ui/interaction/{uid}/verify — re-renders the code page after the
 * backend's atomic verify+complete rejects a code and redirects the browser
 * here. Verification itself happens on the backend (the form posts to the
 * crumb-protected complete route below, which forwards through the proxy);
 * this route only handles the "try again" return leg.
 * @param {Request} request
 * @param {ResponseToolkit} h
 */
export function getVerify(request, h) {
  const uid = /** @type {string} */ (request.params.uid)
  const query = /** @type {{ email?: string, error?: string }} */ (
    request.query
  )
  return verifyView(h, uid, query.email ?? '', {
    invalidCode: Boolean(query.error)
  })
}

/**
 * POST /interaction/{uid}/complete (crumb-protected) — forwards the code to
 * the identity API's atomic verify+complete endpoint. `@hapi/crumb` has
 * already validated and consumed the crumb field by the time this runs, so
 * the remaining fields are re-encoded and forwarded through the same hardened
 * proxy path — preserving the browser's interaction cookies and X-Forwarded-*
 * — and the upstream redirect (provider resume on success, back to the verify
 * page on a rejected code) plus its set-cookies relay back untouched. This
 * keeps the POC's atomicity guarantee: there is no completion without a valid
 * code, and the accountId never comes from the wire.
 * @param {Request} request
 * @param {ResponseToolkit} h
 */
export function postComplete(request, h) {
  const payload = /** @type {{ email?: string, code?: string }} */ (
    request.payload
  )
  return proxyToIdentityApi(request, h, {
    body: new URLSearchParams({
      email: payload.email ?? '',
      code: payload.code ?? ''
    })
  })
}

/**
 * @import { Request, ResponseToolkit } from '@hapi/hapi'
 */
