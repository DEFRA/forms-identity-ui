import { within } from '@testing-library/dom'

/**
 * Injects a request and renders the HTML response into the shared JSDOM
 * document, returning Testing Library queries scoped to it (forms-designer
 * convention) — so content and page-hierarchy assertions read the page the
 * way a user (or screen reader) would, via roles and accessible names
 * @param {Server} server
 * @param {ServerInjectOptions} options
 */
export async function renderResponse(server, options) {
  const response = /** @type {ServerInjectResponse<string>} */ (
    await server.inject(options)
  )

  const result = renderDOM(response.result)
  return { ...result, response }
}

/**
 * Renders HTML into the shared JSDOM document (created by global-jsdom in
 * jest.environment.js)
 * @param {string} [html]
 */
export function renderDOM(html = '') {
  const { window } = globalThis.$jsdom

  window.document.body.innerHTML = html

  const document = window.document
  const container = within(document.body)

  return { container, document }
}

/**
 * @import { Server, ServerInjectOptions, ServerInjectResponse } from '@hapi/hapi'
 */
