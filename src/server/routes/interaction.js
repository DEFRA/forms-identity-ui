import { StatusCodes } from 'http-status-codes'
import Joi from 'joi'
import { errors } from 'oidc-provider'

import * as signinService from '~/src/server/services/signin-service.js'

const uidParams = Joi.object({ uid: Joi.string().required() })

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
 * Completes the OIDC interaction with a signed-in account. The provider
 * writes the resume redirect straight to the socket, so the handler must
 * return h.abandon.
 * @param {Request} request
 * @param {ResponseToolkit} h
 * @param {string} accountId
 */
async function finishLogin(request, h, accountId) {
  await request.server.app.oidcProvider.interactionFinished(
    request.raw.req,
    request.raw.res,
    { login: { accountId } },
    { mergeWithLastSubmission: false }
  )
  return h.abandon
}

/**
 * Sign-in interaction pages. Handlers extract raw request data, hand it to
 * the signin service, and translate the returned outcome into a response.
 * Rendering is optimistic; every submission is enforced by the API's otps
 * state machine — identity only ever derives from server-side state. Crumb
 * protects every POST (the hidden field is in each form); the protocol
 * endpoints in the oidc plugin are the only crumb-exempt routes.
 */
export default /** @type {ServerRoute[]} */ ([
  {
    method: 'GET',
    path: '/interaction/{uid}',
    options: { validate: { params: uidParams } },
    handler(request, h) {
      return withInteraction(request, h, async (details) => {
        const provider = request.server.app.oidcProvider

        // Consent prompts are auto-granted: single first-party client
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
    }
  },
  {
    method: 'POST',
    path: '/interaction/{uid}/email',
    options: { validate: { params: uidParams } },
    handler(request, h) {
      return withInteraction(request, h, async (details) => {
        const { email } = /** @type {{ email?: string }} */ (request.payload)
        const result = await signinService.submitEmail(details.uid, email)

        if (result.outcome === 'invalid-email') {
          return h.view('interaction/email', {
            uid: details.uid,
            email: result.email,
            errorKey: result.errorKey
          })
        }

        return h.redirect(
          `/interaction/${details.uid}/code?email=${encodeURIComponent(result.email)}`
        )
      })
    }
  },
  {
    method: 'GET',
    path: '/interaction/{uid}/code',
    options: { validate: { params: uidParams } },
    handler(request, h) {
      return withInteraction(request, h, (details) =>
        h.view('interaction/code', {
          uid: details.uid,
          // display-only — verification compares against the stored target
          email: request.query.email ?? ''
        })
      )
    }
  },
  {
    method: 'POST',
    path: '/interaction/{uid}/code',
    options: { validate: { params: uidParams } },
    handler(request, h) {
      return withInteraction(request, h, async (details) => {
        const { code, email } =
          /** @type {{ code?: string, email?: string }} */ (request.payload)
        const result = await signinService.submitCode(details.uid, code)

        if (result.outcome === 'signed-in') {
          return finishLogin(request, h, result.accountId)
        }
        if (result.outcome === 'phone-required') {
          return h.redirect(`/interaction/${details.uid}/phone`)
        }

        return h.view('interaction/code', {
          uid: details.uid,
          email: email ?? '',
          errorKey: result.errorKey
        })
      })
    }
  },
  {
    method: 'GET',
    path: '/interaction/{uid}/phone',
    options: { validate: { params: uidParams } },
    handler(request, h) {
      return withInteraction(request, h, (details) =>
        h.view('interaction/phone', { uid: details.uid })
      )
    }
  },
  {
    method: 'POST',
    path: '/interaction/{uid}/phone',
    options: { validate: { params: uidParams } },
    handler(request, h) {
      return withInteraction(request, h, async (details) => {
        const { phone } = /** @type {{ phone?: string }} */ (request.payload)
        const result = await signinService.submitPhone(details.uid, phone)

        if (result.outcome === 'signed-in') {
          return finishLogin(request, h, result.accountId)
        }
        if (result.outcome === 'invalid-phone') {
          return h.view('interaction/phone', {
            uid: details.uid,
            phone: result.phone,
            errorKey: result.errorKey
          })
        }

        // out of order / replay — restart the journey at the email page
        return h.redirect(`/interaction/${details.uid}`)
      })
    }
  }
])

/**
 * @import { Request, ResponseObject, ResponseToolkit, ServerRoute } from '@hapi/hapi'
 * @typedef {Awaited<ReturnType<import('oidc-provider').default['interactionDetails']>>} InteractionDetails
 */
