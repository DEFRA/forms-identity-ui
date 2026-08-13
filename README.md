# forms-identity-ui

The sign-in service for Defra Forms, and the OpenID Connect provider other
services authenticate against.

This is the only part of the identity system a browser reaches. It runs
[node-oidc-provider](https://github.com/panva/node-oidc-provider) and hosts the
GOV.UK-styled sign-in pages. It has no database: accounts, one-time codes and
every protocol artefact live in
[forms-identity-api](https://github.com/DEFRA/forms-identity-api), reached over
the internal network. forms-runner is the relying party — it sends a citizen
here and gets back an ID token.

Authentication is a passwordless email OTP. A citizen enters an email address,
receives a six digit code, and enters it back. First-time users also give a
mobile number and an account is created for them.

## Requirements

- Node.js `^22.11.0` — run `nvm use` (see `.nvmrc`)
- npm `>=10.9.0`
- forms-identity-api running locally, with its Docker Mongo

## Setup

```sh
nvm use
npm install
cp .env.sample .env
```

Every setting in `.env.sample` needs a value — the service refuses to start
without them, so a misconfigured environment fails at boot rather than at first
sign-in. Two need generating:

```sh
node scripts/generate-jwks.mjs            # OIDC_JWKS — our ID token signing key
node scripts/generate-client-keypair.mjs  # the client's keypair, both halves
```

The second prints two values. `OIDC_RUNNER_JWKS` is the public half and belongs
here. `EXAMPLE_RP_PRIVATE_JWKS` is the private half, held by the client — for
local development that is the example RP, and in a real environment it is
forms-runner and nothing else.

Each key is named after its role, its algorithm and a random tail —
`sig-es256-4c1f8ab390d7`. Rotating means running the script again and replacing
the value: the new key names itself, so there is nothing to keep track of, and
a copy of the old key found later still answers to the old name.

## Development

```sh
npm run dev
```

That starts three things at once:

| Process        | Where                 | Reloads on change                  |
| -------------- | --------------------- | ---------------------------------- |
| webpack client | builds to `.public`   | yes, watches `src/client`          |
| the service    | http://localhost:3011 | yes, `tsx watch` restarts it       |
| the example RP | http://localhost:3901 | no, plain `node` — restart by hand |

The session cache uses memory by default. To use Redis instead, run
`docker compose up -d redis` and set `SESSION_CACHE_ENGINE=redis` in `.env`.

## Development workflow

Changing a sign-in page and seeing it work end to end.

**1. Start everything.** forms-identity-api first (`npm run dev` there, with its
Mongo), then `npm run dev` here.

**2. Make the change.** Interaction pages live in
`src/server/views/interaction/`, their routes in
`src/server/routes/interaction.js`, and the decisions behind them in
`src/server/services/signin-service.js`. Wording belongs in
`src/server/i18n/translations/en-GB.json` rather than in a template. The server
restarts on save.

**3. Drive it from the example RP,** not by visiting :3011 directly. Open
http://localhost:3901 and follow the sign-in link. Starting at the RP is what
creates the authorization request, and without one the interaction pages have
nothing to resume — visiting them directly just shows the timed-out page.

**4. Get past the code step.** The code is emailed through GOV.UK Notify. A
team-only API key refuses any address that is not on your Notify team, so the
page shows an error even though the code was stored. Either use an address on
the team, or overwrite the stored code with the one the tests use:

```sh
# take the uid from the URL: /interaction/<uid>/code
node -e "import('./e2e/support.mjs').then(m => m.captureCode('<uid>', '<email>'))"
```

Then go back to `/interaction/<uid>/code` and enter `123456`.

**5. Check the result.** After the mobile step the RP shows the ID token claims,
the token response and userinfo. That page is proof the whole exchange worked,
including the client assertion and the ID token signature check that
`openid-client` performs. "Sign out" clears both sessions so you can run it
again; "Sign in again" reuses the provider session and skips straight through.

Two things that catch people out. Editing anything under `example/rp` needs the
RP restarted by hand, since it is plain `node` rather than watched. And killing
the RP while `npm run dev` is running takes the whole stack down with it, because
`concurrently` runs with `--kill-others`.

## Testing and linting

```sh
npm test          # jest unit tests with coverage
npm run test:e2e  # Playwright sign-in journey (see below)
npm run lint      # editorconfig + eslint + tsc
npm run lint:scss # stylelint
npm run format    # prettier write
```

### End-to-end tests

`npm run test:e2e` drives the whole journey through a real browser: JIT sign-up,
single sign-on, the existing-account path, CSRF rejection, and client
authentication at the token endpoint.

It uses the example RP as the relying party, so the tests exercise the same
`openid-client` code a developer clicks through by hand, and a change that
breaks one breaks the other. Playwright starts the RP if it is not already
running.

It needs forms-identity-api running with its Mongo, and this service running.
The API's `.env` needs the Notify variables set, but dummy-format values are
fine — the tests read the code from the database rather than an inbox.

## Production build

```sh
npm run build # babel server build to .server, webpack client build to .public
npm start     # build then serve on PORT (default 3011)
```

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable information providers in the public sector to license the use and re-use of their information under a common open licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
