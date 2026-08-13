/**
 * End-to-end sign-in journey against local dev servers, driven through a real
 * browser. The relying party is example/rp — the same one a developer clicks
 * through by hand — so the test exercises the code forms-runner will copy,
 * including the client assertion and ID token validation openid-client does.
 *
 * Prerequisites: see playwright.config.mjs.
 */
import { expect, test } from '@playwright/test'

import {
  ISSUER,
  KNOWN_CODE,
  RP,
  captureCode,
  tokenEndpoint
} from './support.mjs'

const EMAIL = `e2e-${Date.now()}@example.com`
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** @type {BrowserContext} */
let context
/** @type {Page} */
let page
/** @type {string} */
let firstSub

test.beforeAll(async ({ browser }) => {
  // one browser context for the whole serial journey, so the provider
  // session set by the first sign-in is still there for the SSO test
  context = await browser.newContext()
  page = await context.newPage()
})

test.afterAll(async () => {
  await context.close()
})

/**
 * Drives the browser from the RP through the email and code steps
 * @param {Page} page
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
  await page.goto(`${ISSUER}/interaction/${uid}/code`)
  await expect(
    page.getByRole('heading', { name: 'Check your email' })
  ).toBeVisible()

  return uid
}

/**
 * A row of one of the RP's tables, by the name in its first column
 * @param {Page} page
 * @param {string | RegExp} tableName
 * @param {string | RegExp} rowName
 */
function detail(page, tableName, rowName) {
  return page
    .getByRole('table', { name: tableName })
    .getByRole('row', { name: rowName })
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

    // a mobile completes the interaction, and the RP exchanges the code and
    // fetches userinfo before it renders
    await phoneInput.fill('07911 123456')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Signed in.')).toBeVisible()

    await expect(detail(page, 'ID token claims', `iss ${ISSUER}`)).toBeVisible()

    firstSub = String(
      await detail(page, 'ID token claims', /^sub /)
        .getByRole('cell')
        .textContent()
    ).trim()
    expect(firstSub).toMatch(UUID_PATTERN) // opaque UUID, never an email

    await expect(
      detail(page, /^Userinfo/, `email ${EMAIL.toLowerCase()}`)
    ).toBeVisible()
    await expect(detail(page, /^Userinfo/, `sub ${firstSub}`)).toBeVisible()
  })

  test('signs straight back in on the provider session (SSO)', async () => {
    // no interaction pages this time — the provider session carries it
    await page.goto(`${RP}/login`)
    await expect(page.getByText('Signed in.')).toBeVisible()
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

    // straight back to the RP — no phone page for an account that exists
    await expect(page.getByText('Signed in.')).toBeVisible()
    await expect(
      detail(page, 'ID token claims', `sub ${firstSub}`)
    ).toBeVisible() // same account

    await context.close()
  })

  test('rejects a crumbless POST with 403 (CSRF)', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(`${RP}/login`)
    const uid = new URL(page.url()).pathname.split('/')[2]

    // same cookies as the browser, but no crumb field in the body
    const res = await page.request.post(`${ISSUER}/interaction/${uid}/email`, {
      form: { email: EMAIL }
    })
    expect(res.status()).toBe(403)

    await context.close()
  })

  test('refuses a token exchange without client credentials', async ({
    request
  }) => {
    // client authentication is checked before the grant, so this needs no
    // real code — an unauthenticated caller is turned away either way
    const res = await request.post(await tokenEndpoint(), {
      form: {
        grant_type: 'authorization_code',
        code: 'not-a-real-code',
        redirect_uri: `${RP}/callback`,
        code_verifier: 'not-a-real-verifier',
        client_id: 'runner'
      }
    })

    expect(res.status()).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'invalid_client' })
  })
})

/**
 * @import { BrowserContext, Page } from '@playwright/test'
 */
