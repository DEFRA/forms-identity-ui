import { renderDOM } from '~/test/helpers/component-helpers.js'

jest.mock('govuk-frontend', () => ({ initAll: jest.fn() }))

describe('application', () => {
  /**
   * Shows a page with a Sign out button, then runs the browser script
   * @param {string} html
   */
  async function runOnPage(html) {
    const { container } = renderDOM(html)
    const click = jest.fn()
    container
      .getByRole('button', { name: 'Sign out' })
      .addEventListener('click', click)

    await import('~/src/client/javascripts/application.js')

    return click
  }

  it('presses the button on a page that the server marks for auto-submit', async () => {
    const click = await runOnPage(
      '<div data-module="app-auto-submit"><button>Sign out</button></div>'
    )

    expect(click).toHaveBeenCalledTimes(1)
  })

  it('leaves the button for the user on other pages', async () => {
    const click = await runOnPage('<div><button>Sign out</button></div>')

    expect(click).not.toHaveBeenCalled()
  })
})
