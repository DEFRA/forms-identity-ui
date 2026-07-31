# forms-identity-ui

Defra Forms identity frontend — the public sign-in façade for Defra Forms identity. A Hapi + nunjucks GOV.UK frontend service.

## Requirements

- Node.js `^22.11.0` — install via [nvm](https://github.com/nvm-sh/nvm) with `nvm use` (see `.nvmrc`)
- npm `>=10.9.0`

## Setup

```sh
nvm use
npm install
```

Configuration is via environment variables — see `.env.sample` for the available options. All have sensible defaults for local development, so no `.env` file is needed to get started.

## Development

```sh
npm run dev
```

Runs the webpack client watch and the server (via `tsx watch`) concurrently on http://localhost:3011.

### Local Redis

The session cache uses an in-memory engine by default in development. To use Redis instead:

```sh
docker compose up -d redis
```

then set `SESSION_CACHE_ENGINE=redis` in your `.env` file.

## Testing and linting

```sh
npm test          # jest with coverage
npm run lint      # editorconfig + eslint + tsc
npm run lint:scss # stylelint
npm run format    # prettier write
```

## Production build

```sh
npm run build # babel server build to .server, webpack client build to .public
npm start     # build then serve on PORT (default 3011)
```

## Trying the journey in a browser (example RP)

A minimal relying party (never deployed — lives outside `src/`) signs in the
way forms-runner will: authorization code + PKCE, confidential client, then
userinfo. Run it with both dev servers up:

```sh
node example/rp/index.mjs   # then open http://localhost:3901
```

After signing in, the home page shows the ID-token claims, a token response
summary and userinfo, with links to repeat sign-in (SSO) and sign out at the
provider.

Note: without a real `NOTIFY_API_KEY` the email step fails loudly on the
provider's error page. Either use a real key, or overwrite the stored
`otps` record's `codeHash` with a known code's argon2 hash (the technique
`scripts/e2e.mjs` uses) and continue from
`/ui/interaction/<uid>/code?email=<email>`.

## Sign-in end-to-end check

Drives the full OIDC + OTP sign-in journey (both the JIT-signup and
existing-account arms, SSO, CSRF and client auth) against local dev servers.

Prerequisites:

- `forms-identity-api` running (`npm run dev`, with its docker-compose mongo
  up) — its `.env` needs the Notify variables set (dummy-format values work;
  the driver captures the code from the database when delivery fails)
- this repo's `.env` populated: `OIDC_JWKS` (`node scripts/generate-jwks.mjs`),
  `OIDC_COOKIE_KEYS` and `OIDC_CLIENT_SECRET` (`openssl rand -hex 32`), and
  `OIDC_RUNNER_REDIRECT_URIS` including the driver's callback
  `http://localhost:3901/callback`
- this repo running (`npm run dev`)

```sh
node scripts/e2e.mjs
```

Every step prints its result; the run fails loudly on any assertion.

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable information providers in the public sector to license the use and re-use of their information under a common open licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
