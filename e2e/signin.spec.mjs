/**
 * End-to-end sign-in journey against local dev servers, driven through a
 * real browser (the interaction pages) plus direct protocol calls (the
 * token exchange forms-runner would perform server-to-server).
 *
 * Prerequisites: see playwright.config.mjs. The UI .env must include the
 * RP callback http://localhost:3902/callback in OIDC_RUNNER_REDIRECT_URIS.
 */
import { expect, test } from '@playwright/test'

import {
  KNOWN_CODE,
  RP,
  captureCode,
  exchangeCode,
  exchangeCodeUnauthenticated,
  idTokenClaims,
  startRp
} from './support.mjs'

const EMAIL = `e2e-${Date.now()}@example.com`
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** @type {Awaited<ReturnType<typeof startRp>>} */
let rp
/** @type {import('@playwright/test').BrowserContext} */
let context
/** @type {import('@playwright/test').Page} */
let page
/** @type {string} */
let firstSub

test.beforeAll(async ({ browser }) => {
  rp = await startRp()
  // one browser context for the whole serial journey, so the provider
  // session set by the first sign-in is still there for the SSO test
  context = await browser.newContext()
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
  await rp.close()
})

/**
 * Drives the browser from the RP through the email and code steps
 * @param {import('@playwright/test').Page} page
 */
async function signInUpToCode(page) {
  await page.goto(`${RP}/login`)
  await expect(
    page.getByRole('heading', { name: 'Enter your email address' })
  ).toBeVisible()

  const uid = new URL(page.url()).pathname.split('/')[2]

  await page
    .getByRole('textbox', { name: 'Enter your email address' })
    .fill(EMAIL)
  await page.getByRole('button', { name: 'Continue' }).click()

  // The one-time code is stored before Notify is called, so delivery
  // failures (a dummy key, or a team key that refuses unknown recipients)
  // surface an error page without losing the journey — swap in the known
  // code and continue from the code page either way
  await captureCode(uid, EMAIL)
  await page.goto(`http://localhost:3011/interaction/${uid}/code`)
  await expect(
    page.getByRole('heading', { name: 'Check your email' })
  ).toBeVisible()

  return uid
}

test.describe.serial('citizen sign-in', () => {
  test('signs a new user up end to end and issues tokens', async () => {
    await signInUpToCode(page)

    // a wrong code re-renders with a GDS error
    const codeInput = page.getByRole('textbox', {
      name: 'Enter the 6 digit security code'
    })
    await codeInput.fill('000000')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('alert')).toContainText('There is a problem')

    // the right code moves to the phone step (no account exists yet)
    await codeInput.fill(KNOWN_CODE)
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(
      page.getByRole('heading', { name: 'Enter your mobile phone number' })
    ).toBeVisible()

    // a landline is rejected without losing the journey
    const phoneInput = page.getByRole('textbox', {
      name: 'Mobile phone number'
    })
    await phoneInput.fill('020 7946 0000')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('alert')).toContainText('There is a problem')

    // a mobile completes the interaction back to the RP
    await phoneInput.fill('07911 123456')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL(`${RP}/callback**`)

    // the RP exchanges the code as the confidential client, proving itself
    // with a signed assertion and validating the ID token it gets back
    const tokens = await exchangeCode(page.url(), rp.pending)
    expect(tokens.id_token).toBeDefined()

    const claims = idTokenClaims(tokens)
    expect(claims.iss).toBe('http://localhost:3011')
    expect(claims.sub).toMatch(UUID_PATTERN) // opaque UUID, never an email
    firstSub = claims.sub

    const userinfo = /** @type {{ email: string, sub: string }} */ (
      await (
        await fetch('http://localhost:3011/me', {
          headers: { authorization: `Bearer ${tokens.access_token}` }
        })
      ).json()
    )
    expect(userinfo.email).toBe(EMAIL.toLowerCase())
    expect(userinfo.sub).toBe(claims.sub)
  })

  test('signs straight back in on the provider session (SSO)', async () => {
    // no interaction pages this time — the provider session carries it
    await page.goto(`${RP}/login`)
    await page.waitForURL(`${RP}/callback**`)
  })

  test('skips the phone step for an existing account', async ({ browser }) => {
    // a fresh browser context = a user on a new device, same email
    const context = await browser.newContext()
    const page = await context.newPage()

    await signInUpToCode(page)
    await page
      .getByRole('textbox', { name: 'Enter the 6 digit security code' })
      .fill(KNOWN_CODE)
    await page.getByRole('button', { name: 'Continue' }).click()

    // straight to the RP — no phone page for an account that exists
    await page.waitForURL(`${RP}/callback**`)

    const tokens = await exchangeCode(page.url(), rp.pending)
    expect(idTokenClaims(tokens).sub).toBe(firstSub) // same account

    await context.close()
  })

  test('rejects a crumbless POST with 403 (CSRF)', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(`${RP}/login`)
    const uid = new URL(page.url()).pathname.split('/')[2]

    // same cookies as the browser, but no crumb field in the body
    const res = await page.request.post(
      `http://localhost:3011/interaction/${uid}/email`,
      { form: { email: EMAIL } }
    )
    expect(res.status()).toBe(403)

    await context.close()
  })

  test('refuses the token exchange without client credentials', async ({
    browser
  }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await signInUpToCode(page)
    await page
      .getByRole('textbox', { name: 'Enter the 6 digit security code' })
      .fill(KNOWN_CODE)
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL(`${RP}/callback**`)

    const res = await exchangeCodeUnauthenticated(page.url(), rp.pending)
    expect(res.status).toBe(401)

    await context.close()
  })
})
