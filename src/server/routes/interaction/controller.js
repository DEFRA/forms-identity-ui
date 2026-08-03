import { StatusCodes } from 'http-status-codes'
import Joi from 'joi'
import { errors } from 'oidc-provider'

import { config } from '~/src/config/index.js'
import { postJson } from '~/src/server/common/helpers/fetch.js'

const apiBaseUrl = config.get('identityApi.url')

const emailSchema = Joi.string().email().required()

/**
 * @typedef {{ status: string, accountId?: string }} DomainResult
 */

/**
 * Runs an interaction handler, rendering the timed-out view when the
 * provider no longer recognises the interaction (expired or cookieless —
 * only the RP can mint a new one via /auth)
 * @param {Request} request
 * @param {ResponseToolkit} h
 * @param {(details: InteractionDetails) => Promise<symbol | ResponseObject> | symbol | ResponseObject} fn
 */
async function withInteraction(request, h, fn) {
  const provider = request.server.app.oidcProvider
  /** @type {InteractionDetails} */
  let details

  try {
    details = await provider.interactionDetails(
      request.raw.req,
      request.raw.res
    )
  } catch (err) {
    // Only a genuinely dead interaction is the user's timeout; anything
    // else (e.g. the persistence tier being down) must surface as a 500
    // through the error-pages plugin, not masquerade as a timeout
    if (err instanceof errors.SessionNotFound) {
      return h.view('interaction/timed-out').code(StatusCodes.GONE)
    }
    throw err
  }

  return fn(details)
}

/**
 * Builds the sign-in interaction page handlers. Rendering is optimistic;
 * every submission is enforced by the API's otps state machine — identity
 * only ever derives from server-side state.
 */
export function makeInteractionController() {
  return {
    /**
     * Entry: consent prompts are auto-granted (single first-party client);
     * login prompts render the email page
     * @param {Request} request
     * @param {ResponseToolkit} h
     */
    entry: (request, h) => {
      return withInteraction(request, h, async (details) => {
        const provider = request.server.app.oidcProvider

        if (details.prompt.name === 'consent') {
          const params = /** @type {{ client_id?: string, scope?: string }} */ (
            details.params
          )
          const grant = new provider.Grant({
            accountId: details.session?.accountId,
            clientId: params.client_id
          })
          grant.addOIDCScope(params.scope ?? '')
          const grantId = await grant.save()
          await provider.interactionFinished(
            request.raw.req,
            request.raw.res,
            { consent: { grantId } },
            { mergeWithLastSubmission: true }
          )
          return h.abandon
        }

        return h.view('interaction/email', { uid: details.uid })
      })
    },

    /**
     * Email submission: UX-validate, ask the API to mint+send a code, move
     * to the code page. The email in the redirect is display-only.
     * @param {Request} request
     * @param {ResponseToolkit} h
     */
    submitEmail: (request, h) => {
      return withInteraction(request, h, async (details) => {
        const { email } = /** @type {{ email?: string }} */ (request.payload)
        const trimmed = (email ?? '').trim()
        const { error } = emailSchema.validate(trimmed)

        if (error) {
          const errorKey = trimmed
            ? 'signin.email.errorFormat'
            : 'signin.email.errorRequired'
          return h.view('interaction/email', {
            uid: details.uid,
            email: trimmed,
            errorKey
          })
        }

        await postJson(new URL('/otp/request', apiBaseUrl), {
          payload: { uid: details.uid, email: trimmed }
        })

        return h.redirect(
          `/interaction/${details.uid}/code?email=${encodeURIComponent(trimmed)}`
        )
      })
    },

    /**
     * Check-your-email page (code entry). The email shown is display-only —
     * verification always compares against the API's stored target.
     * @param {Request} request
     * @param {ResponseToolkit} h
     */
    showCode: (request, h) => {
      return withInteraction(request, h, (details) =>
        h.view('interaction/code', {
          uid: details.uid,
          email: request.query.email ?? ''
        })
      )
    },

    /**
     * Code submission: the API's verify result routes the journey —
     * signed-in | phone-required | expired | invalid
     * @param {Request} request
     * @param {ResponseToolkit} h
     */
    submitCode: (request, h) => {
      return withInteraction(request, h, async (details) => {
        const provider = request.server.app.oidcProvider
        const { code, email } =
          /** @type {{ code?: string, email?: string }} */ (request.payload)
        const trimmedCode = (code ?? '').trim()
        const displayEmail = email ?? ''

        if (!trimmedCode) {
          return h.view('interaction/code', {
            uid: details.uid,
            email: displayEmail,
            errorKey: 'signin.code.errorRequired'
          })
        }

        const { body } = await postJson(new URL('/otp/verify', apiBaseUrl), {
          payload: { uid: details.uid, code: trimmedCode }
        })
        const result = /** @type {DomainResult} */ (body)

        if (result.status === 'signed-in') {
          await provider.interactionFinished(
            request.raw.req,
            request.raw.res,
            { login: { accountId: /** @type {string} */ (result.accountId) } },
            { mergeWithLastSubmission: false }
          )
          return h.abandon
        }

        if (result.status === 'phone-required') {
          return h.redirect(`/interaction/${details.uid}/phone`)
        }

        if (result.status === 'expired') {
          return h.redirect(
            `/interaction/${details.uid}/expired?email=${encodeURIComponent(displayEmail)}`
          )
        }

        return h.view('interaction/code', {
          uid: details.uid,
          email: displayEmail,
          errorKey: 'signin.code.errorInvalid'
        })
      })
    },

    /**
     * Recovery phone page (JIT signup only)
     * @param {Request} request
     * @param {ResponseToolkit} h
     */
    showPhone: (request, h) => {
      return withInteraction(request, h, (details) =>
        h.view('interaction/phone', { uid: details.uid })
      )
    },

    /**
     * Phone submission: completes JIT signup. `invalid` here means the API
     * refused the completion (no verified record — out of order / replay),
     * so restart the journey at the email page.
     * @param {Request} request
     * @param {ResponseToolkit} h
     */
    submitPhone: (request, h) => {
      return withInteraction(request, h, async (details) => {
        const provider = request.server.app.oidcProvider
        const { phone } = /** @type {{ phone?: string }} */ (request.payload)
        const trimmed = (phone ?? '').trim()

        if (!trimmed) {
          return h.view('interaction/phone', {
            uid: details.uid,
            errorKey: 'signin.phone.errorRequired'
          })
        }

        const { body } = await postJson(new URL('/accounts', apiBaseUrl), {
          payload: { uid: details.uid, phone: trimmed }
        })
        const result = /** @type {DomainResult} */ (body)

        if (result.status === 'signed-in') {
          await provider.interactionFinished(
            request.raw.req,
            request.raw.res,
            { login: { accountId: /** @type {string} */ (result.accountId) } },
            { mergeWithLastSubmission: false }
          )
          return h.abandon
        }

        if (result.status === 'invalid-phone') {
          return h.view('interaction/phone', {
            uid: details.uid,
            phone: trimmed,
            errorKey: 'signin.phone.errorInvalid'
          })
        }

        return h.redirect(`/interaction/${details.uid}`)
      })
    },

    /**
     * Security-code-expired page (prototype). The button is a GET link back
     * to the email page for the SAME interaction — its 1h TTL outlives the
     * code's 15 min, and only the RP can mint a new interaction.
     * @param {Request} request
     * @param {ResponseToolkit} h
     */
    showExpired: (request, h) => {
      return withInteraction(request, h, (details) =>
        h.view('interaction/expired', {
          uid: details.uid,
          email: request.query.email ?? ''
        })
      )
    }
  }
}

/**
 * @import { Request, ResponseObject, ResponseToolkit } from '@hapi/hapi'
 * @typedef {Awaited<ReturnType<import('oidc-provider').default['interactionDetails']>>} InteractionDetails
 */
