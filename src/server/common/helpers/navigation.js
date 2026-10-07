import { SESSION_KEY_BACK_LINK } from '~/src/server/common/constants/session-names.js'

/**
 * Gets the back link from the session
 * @param {Yar} yar
 * @returns {{ href: string } | undefined}
 */
export function getBackLink(yar) {
  const href = /** @type {string | undefined} */ (
    yar.get(SESSION_KEY_BACK_LINK)
  )
  return href ? { href } : undefined
}

/**
 * @import { Yar } from '@hapi/yar'
 */
