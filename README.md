# forms-identity-ui

The sign-in service for Defra Forms. It runs the OIDC provider
(node-oidc-provider) and the GOV.UK sign-in pages. Account and one-time-code
data lives in [forms-identity-api](https://github.com/DEFRA/forms-identity-api).

## Requirements

- Node.js `^22.11.0` — run `nvm use` (see `.nvmrc`)
- npm `>=10.9.0`

## Setup

```sh
nvm use
npm install
cp .env.sample .env
```

Every setting in `.env.sample` marked required must have a value — the
service refuses to start without them. Generate the secrets as the comments
in `.env.sample` describe.

## Development

```sh
npm run dev
```

Starts the webpack client watch, the server on http://localhost:3011 and the
example relying party on http://localhost:3901.

The session cache uses memory by default. To use Redis instead, run
`docker compose up -d redis` and set `SESSION_CACHE_ENGINE=redis` in `.env`.

## Testing and linting

```sh
npm test          # jest unit tests with coverage
npm run test:e2e  # Playwright sign-in journey (needs the servers below)
npm run lint      # editorconfig + eslint + tsc
npm run lint:scss # stylelint
npm run format    # prettier write
```

### End-to-end tests

`npm run test:e2e` drives the whole sign-in journey through a browser:
JIT sign-up, single sign-on, the existing-account path, CSRF rejection and
client authentication at the token endpoint.

It needs:

- forms-identity-api running (`npm run dev` there, with its docker mongo).
  Its `.env` needs the Notify variables set — dummy-format values work,
  because the tests read the code from the database instead of an inbox.
- this repo running (`npm run dev`), with `OIDC_RUNNER_REDIRECT_URIS`
  including the test callback `http://localhost:3902/callback`.

## Trying the journey by hand (example RP)

A small relying party in `example/rp` (never deployed) signs in the way
forms-runner will, using [openid-client](https://github.com/panva/openid-client).
With `npm run dev` running here and forms-identity-api running too, open
http://localhost:3901 and follow the links. After signing in it shows the
ID token claims, the token response and userinfo.

Without a real `NOTIFY_API_KEY` in the API the email step fails on an error
page. Either use a real key, or overwrite the stored code as the e2e tests
do (`e2e/support.mjs`) and continue from `/interaction/<uid>/code`.

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
