/**
 * End-to-end journey for a user who opens the account pages after the
 * provider session has ended, against local dev servers and a real browser.
 * The relying party is example/rp, which stands in for forms-runner: it has
 * the "Security" link and the endpoint where the provider asks for a sign in.
 *
 * Prerequisites: see playwright.config.mjs.
 */
import { expect, test } from '@playwright/test'

import { ISSUER, KNOWN_CODE, RP, captureCode } from './support.mjs'

const EMAIL = `e2e-account-${Date.now()}@example.com`

/** @type {BrowserContext} */
let context
/** @type {Page} */
let page

test.beforeAll(async ({ browser }) => {
  // one browser context for the whole serial journey, so the relying party
  // and the provider keep their cookies between the tests
  context = await browser.newContext()
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

/**
 * Completes the email and code steps, from the email page the browser is on
 * @param {Page} page
 */
async function enterEmailAndCode(page) {
  await expect(
    page.getByRole('heading', { name: 'Enter your email address' })
  ).toBeVisible()

  const uid = new URL(page.url()).pathname.split('/')[2]

  await page
    .getByRole('textbox', { name: 'Enter your email address' })
    .fill(EMAIL)
  await page.getByRole('button', { name: 'Continue' }).click()

  // The code is stored before Notify is called, so the known code can
  // replace it whether or not the email was sent
  await captureCode(uid, EMAIL)
  await page.goto(`${ISSUER}/interaction/${uid}/code`)
  await page
    .getByRole('textbox', { name: 'Enter the 6 digit security code' })
    .fill(KNOWN_CODE)
  await page.getByRole('button', { name: 'Continue' }).click()
}

/**
 * The account page, with the signed-in user's email and a way back to the
 * relying party
 * @param {Page} page
 */
async function expectAccountPage(page) {
  await expect(
    page.getByRole('heading', { level: 1, name: 'Security' })
  ).toBeVisible()
  await expect(page.getByText(EMAIL.toLowerCase())).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back' })).toHaveAttribute(
    'href',
    `${RP}/`
  )
}

test.describe
  .serial('account pages after the provider session has ended', () => {
  test('opens the account page for a user who has just signed in', async () => {
    await page.goto(`${RP}/login`)
    await enterEmailAndCode(page)

    // a new account gives its phone number once
    await page
      .getByRole('textbox', { name: 'Mobile phone number' })
      .fill('07911 123456')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Signed in.')).toBeVisible()

    await page.getByRole('link', { name: 'Security' }).click()

    await expectAccountPage(page)
  })

  test('takes a user with no provider session through sign in, then to the account page', async () => {
    // The provider session ends and the relying party stays signed in, as it
    // does when the relying party keeps its sign in with a refresh token
    await context.clearCookies({ name: /^_session/ })

    await page.goto(RP)
    await expect(page.getByText('Signed in.')).toBeVisible()

    /** @type {string[]} */
    const visited = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        visited.push(frame.url())
      }
    })

    await page.getByRole('link', { name: 'Security' }).click()

    // the provider sent the user to the relying party, which started the
    // sign in: the email page is the first page the user sees
    await enterEmailAndCode(page)

    await expectAccountPage(page)
    expect(new URL(page.url()).pathname).toBe('/account')
    expect(visited.some((url) => url.includes('/interaction/'))).toBe(true)
  })

  test('takes a user from a step in a journey through sign in at the relying party that sent them, then to the account page', async () => {
    await page.getByRole('link', { name: /^Change\s+email address/i }).click()
    await expect(page).toHaveURL(/\/account\/[^/]+\/change-email$/)

    // the request for the next page names no relying party, so the provider
    // uses the one that sent the user to the account page
    await context.clearCookies({ name: /^_session/ })
    await page.reload()

    await enterEmailAndCode(page)

    await expectAccountPage(page)
  })

  test('tells a user that no relying party sent to sign in again', async ({
    browser
  }) => {
    // a new browser context has no provider session and no earlier visit
    const context = await browser.newContext()
    const page = await context.newPage()

    const response = await page.goto(`${ISSUER}/account`)

    expect(response?.status()).toBe(401)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sign in again' })
    ).toBeVisible()

    await context.close()
  })
})

/**
 * @import { BrowserContext, Page } from '@playwright/test'
 */
