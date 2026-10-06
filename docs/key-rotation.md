# Key rotation

This document tells you how to change the keys that this service uses. You do
not need to know OIDC to follow it.

> **Check the live config before each task.** This document can be out of
> date. Waiting times, key numbers and setting names come from the live
> config of each environment, and the live config is always correct. Where
> this document gives a time, it is an example only.

## Contents

- [Words used in this document](#words-used-in-this-document)
- [The keys](#the-keys)
- [Rules](#rules)
- [Before you start](#before-you-start)
- [Set up an environment for the first time](#set-up-an-environment-for-the-first-time)
- [Task 1: Add a new key](#task-1-add-a-new-key)
- [Task 2: Move the pointer](#task-2-move-the-pointer)
- [Task 3: Delete an old key](#task-3-delete-an-old-key)
- [Full rotation](#full-rotation)
- [Go back to the old key](#go-back-to-the-old-key)
- [A key is stolen or leaked](#a-key-is-stolen-or-leaked)
- [Rotate the runner key pair](#rotate-the-runner-key-pair)
- [Tokens](#tokens)
- [Startup errors](#startup-errors)

## Words used in this document

| Word    | Meaning                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| Key     | A secret value that this service uses to sign things. A signature proves that this service made the item.           |
| Token   | A signed item that this service gives to a user who signs in. Other services accept it as proof of who the user is. |
| Cookie  | A signed item in the user's browser. It tells this service that the user is signed in.                              |
| Session | The time that a user stays signed in.                                                                               |
| Secret  | A setting that you can write or delete, but that you cannot read.                                                   |
| Config  | A setting that you can read and change.                                                                             |
| Pointer | A config setting that holds the number of the key that signs.                                                       |
| Deploy  | Restart the service so that it reads the settings again.                                                            |
| Runner  | The forms-runner service. Users fill in forms there.                                                                |

## The keys

This service has two sets of keys. Each set works the same way.

| Set          | What it signs | Key settings (secret)                         | Pointer (config)          |
| ------------ | ------------- | --------------------------------------------- | ------------------------- |
| Signing keys | Tokens        | `OIDC_JWKS_KEY_1`, `OIDC_JWKS_KEY_2`, ...     | `OIDC_JWKS_SIGNING_KEY`   |
| Cookie keys  | Cookies       | `OIDC_COOKIE_KEY_1`, `OIDC_COOKIE_KEY_2`, ... | `OIDC_COOKIE_SIGNING_KEY` |

How a set works:

- Each key has a number. The number is the last part of the setting name.
- The pointer holds one number. The key with that number signs all new items.
- The service accepts items that were signed by any key in the set.
- When you delete a key, the service refuses all items that the key signed.

Example: the keys are `OIDC_JWKS_KEY_4` and `OIDC_JWKS_KEY_5`, and
`OIDC_JWKS_SIGNING_KEY` is `5`. Key 5 signs new tokens. Tokens from key 4
are still accepted.

## Rules

1. Do one task at a time. Deploy after each task.
2. Add a key before you point at it.
3. Move the pointer before you delete the old key.
4. Never delete the key that the pointer names.
5. Never use a key number again. The next number is the highest key number in the startup log plus 1. Usually that is the pointer number plus 1.
6. Do the work in one environment at a time. Do a test environment first.
7. Never put a key value in a ticket, a chat message, a commit or a log.

## Before you start

Do these checks in the environment that you will change.

1. Read the pointer in the live config. Write down the number. This document calls it `N`.
2. Look at the newest startup log of the service. It lists the key numbers that are loaded. Make sure that the list agrees with what you expect. See [How to read the startup log](#how-to-read-the-startup-log).
3. Read the live value of each setting in this table. You need them for the waiting times.

| Setting                  | Service           | What it controls                                |
| ------------------------ | ----------------- | ----------------------------------------------- |
| `SESSION_TIMEOUT`        | forms-runner      | How long a user stays signed in to the runner   |
| `OIDC_TTL_SESSION`       | forms-identity-ui | How long a user stays signed in to this service |
| `OIDC_TTL_ACCESS_TOKEN`  | forms-identity-ui | How long an access token works                  |
| `OIDC_TTL_ID_TOKEN`      | forms-identity-ui | How long an ID token works                      |
| `OIDC_TTL_REFRESH_TOKEN` | forms-identity-ui | How long a refresh token works                  |

Check the units. Some settings are in seconds and some are in milliseconds.
The description of each setting in the config file of its service gives the
unit.

### How to read the startup log

Search the log of forms-identity-ui for `[oidcKeys]`. The lines look like
this:

```text
[oidcKeys] Signing keys loaded - OIDC_JWKS_KEY_5 signs - 5: sig-rs256-4c1f8ab390d7, 4: sig-rs256-9e2b71c0aa13
[oidcKeys] Cookie keys loaded - OIDC_COOKIE_KEY_2 signs - 2, 1
```

The first line says that keys 5 and 4 are loaded and that key 5 signs. The
text after each number is the public name of the key. It is not secret.

## Set up an environment for the first time

Use this for a new environment, and one time for each environment that still
has the old settings `OIDC_JWKS` and `OIDC_COOKIE_KEYS`.

1. Run `node scripts/generate-jwks.mjs` in this repository. Add the output as the secret `OIDC_JWKS_KEY_1`.
2. Run `openssl rand -hex 32`. Add the output as the secret `OIDC_COOKIE_KEY_1`.
3. Set the config `OIDC_JWKS_SIGNING_KEY` to `1` and `OIDC_COOKIE_SIGNING_KEY` to `1`.
4. Deploy forms-identity-ui.
5. Look at the startup log. Make sure that key 1 signs in each set.
6. Delete the secrets `OIDC_JWKS` and `OIDC_COOKIE_KEYS` if the environment has them. The service does not read them.

In an environment that had the old settings, the old keys cannot be copied,
because a secret cannot be read. The new keys replace them. All users must
sign in again, and tokens from before the change stop working. Tell the
users of that environment before you start.

## Task 1: Add a new key

This task adds a key. The new key does not sign anything yet.

1. Read the pointer. It is `N`. The new key number is `N+1`.
2. Make the key value. For a signing key, run `node scripts/generate-jwks.mjs` in this repository. For a cookie key, run `openssl rand -hex 32`. Copy the output.
3. Add a secret with the new number and paste the value. The name is `OIDC_JWKS_KEY_<N+1>` for a signing key, or `OIDC_COOKIE_KEY_<N+1>` for a cookie key.
4. Deploy forms-identity-ui.
5. Look at the startup log. Make sure that it lists the new key number.
6. Close the terminal window, so that the key value is not kept on screen.

Do not change the pointer in this task.

## Task 2: Move the pointer

This task makes the new key sign. Do it only after Task 1 is complete.

1. Make sure that the startup log lists key `N+1`. If it does not, stop and do Task 1 again.
2. Signing keys only: wait until the other services have the new key. See [How long to wait before you move the pointer](#how-long-to-wait-before-you-move-the-pointer).
3. Change the pointer from `N` to `N+1`. The pointer is `OIDC_JWKS_SIGNING_KEY` for signing keys, or `OIDC_COOKIE_SIGNING_KEY` for cookie keys.
4. Deploy forms-identity-ui.
5. Look at the startup log. Make sure that it shows key `N+1` as the key that signs.
6. Sign in through the runner in that environment. Make sure that sign in and sign out work.

If the pointer names a number that has no key, the service does not start.
See [Startup errors](#startup-errors).

### How long to wait before you move the pointer

The runner and the APIs that accept our tokens keep a copy of our public
keys. A service with an old copy does not know the new key.

- Wait until each of these services has a fresh copy.
- The time depends on each service. Ask the team that owns the service if
  you do not know.
- Cookie keys need no wait. Only this service reads them.

## Task 3: Delete an old key

This task makes the service refuse all items that the old key signed. Do it
only after Task 2 is complete.

1. Read the pointer. Make sure that it does not name the key that you will delete.
2. Wait until no user holds an item that the old key signed. See [How long to wait before you delete a key](#how-long-to-wait-before-you-delete-a-key).
3. Delete the secret of the old key.
4. Deploy forms-identity-ui.
5. Look at the startup log. Make sure that the old key number is not in the list.
6. Sign in through the runner in that environment. Make sure that sign in and sign out work.

### How long to wait before you delete a key

Start the wait at the time that Task 2 was deployed.

| Set          | Wait for at least                                         | Why                                                                                                                       |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Signing keys | The live value of `SESSION_TIMEOUT` in forms-runner       | The runner keeps a token for the full session and sends it back at sign out. If the key is gone, sign out shows an error. |
| Cookie keys  | The live value of `OIDC_TTL_SESSION` in forms-identity-ui | A user with an older cookie must sign in again if the key is gone.                                                        |

Example only: if the live `SESSION_TIMEOUT` is 4 hours, wait at least 4
hours after Task 2 before you delete the old signing key.

If you delete a key too early, no data is lost. Some users see an error at
sign out, or must sign in again.

## Full rotation

A full rotation is the three tasks in order.

1. [Task 1: Add a new key](#task-1-add-a-new-key). Deploy.
2. Wait. Then [Task 2: Move the pointer](#task-2-move-the-pointer). Deploy.
3. Wait. Then [Task 3: Delete an old key](#task-3-delete-an-old-key). Deploy.

Rotate the signing keys and the cookie keys as two separate rotations.

## Go back to the old key

Use this if there is a problem after Task 2, and you have not done Task 3.

1. Change the pointer back to `N`.
2. Deploy forms-identity-ui.
3. Leave key `N+1` in place. Tokens that it signed are still accepted.
4. Tell a developer about the problem before you try again.

If key `N+1` is the cause of the problem, delete it after the wait in
[Task 3](#task-3-delete-an-old-key). Use `N+2` for the next new key.

You cannot go back after Task 3, because the old key is deleted. Do a full
rotation to a new key.

## A key is stolen or leaked

Do this as fast as you can. Do not wait between the tasks.

1. Do [Task 1](#task-1-add-a-new-key). Deploy.
2. Do [Task 2](#task-2-move-the-pointer) without the wait. Deploy.
3. Do [Task 3](#task-3-delete-an-old-key) for the stolen key without the wait. Deploy.
4. Tell the security contact for the service.

What users see:

- Stolen signing key: tokens from that key stop working. Signed-in users can
  see an error at sign out until their session gets a new token or ends.
- Stolen cookie key: users who signed in with that key must sign in again.

This is correct. A stolen key must stop working at once.

## Rotate the runner key pair

The runner proves to this service who it is with a key pair. A key pair has
two parts that work together:

- The private part is a secret in forms-runner: `OIDC_CLIENT_PRIVATE_JWK`.
  The runner holds one.
- The public part is config in forms-identity-ui: `OIDC_RUNNER_JWKS`. It is
  a list, and it can hold more than one public part.

The two parts have the same `kid` value. That is how you know which public
part goes with which private part. The `kid` is not secret.

Steps:

1. Run `node scripts/generate-client-keypair.mjs` in this repository. The output has the private part and the public part.
2. Read the live `OIDC_RUNNER_JWKS`. Add the new public part to the `keys` list. Keep the old one in the list.
3. Deploy forms-identity-ui. Wait until the deploy is complete.
4. Overwrite `OIDC_CLIENT_PRIVATE_JWK` in forms-runner with the new private part.
5. Deploy forms-runner. Wait until all old copies of the runner have stopped.
6. Sign in through the runner. Make sure that sign in works.
7. Remove the old public part from `OIDC_RUNNER_JWKS`. Use the `kid` to find it.
8. Deploy forms-identity-ui.

Do the steps in this order. If the runner gets the new private part before
this service has the new public part, no user can sign in.

To go back before step 7: the old private part is not kept, so make a new
key pair and start again at step 1.

## Tokens

### Kinds of token

| Token         | What it does                                           | Signed by a signing key                      |
| ------------- | ------------------------------------------------------ | -------------------------------------------- |
| Access token  | The runner sends it to an API to prove who the user is | Yes                                          |
| ID token      | Tells the runner who signed in                         | Yes                                          |
| Refresh token | The runner uses it to get new access tokens            | No. This service keeps a record of each one. |

### Refresh a token

You do not do this by hand. When an access token is near its end, the runner
uses the refresh token to get a new one. The new tokens are signed by the key
that the pointer names at that time.

After a rotation, signed-in users get tokens from the new key at their next
refresh. They do not sign in again.

### Revoke a token

To revoke a token is to make it stop working before its normal end.

| What you want                                            | How                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| End the tokens of one user                               | The user signs out in the runner. The runner tells this service to end the refresh token of the user and all tokens that came from it. |
| End all access tokens and ID tokens from one signing key | Delete that key. Do [Task 3](#task-3-delete-an-old-key). Each API refuses the tokens when it gets a fresh copy of our public keys.     |
| Make all users sign in to this service again             | Rotate the cookie keys and delete the old cookie key without the wait.                                                                 |

Limits that you must know:

- There is no operator task that ends the tokens of one user. The user must
  sign out. If you must end one user's tokens and the user cannot sign out,
  ask a developer.
- When you delete a signing key, refresh tokens continue to work. The runner
  uses them to get new tokens from the new key. To end refresh tokens for
  all users, ask a developer.
- An access token works until its normal end, or until its key is deleted.
  The live value of `OIDC_TTL_ACCESS_TOKEN` gives the normal end.

## Startup errors

The service checks the keys when it starts. If a check fails, the service
does not start and the deploy fails. Correct the setting and deploy again.

| The log says                                                                                | Cause                                                                | What to do                                                                            |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `OIDC_JWKS_SIGNING_KEY is 100, but the keys that exist are 1, 2, 3`                         | The pointer names a key that is not there                            | Set the pointer to a number in the list, or add the key. Deploy.                      |
| `OIDC_JWKS_SIGNING_KEY is 1, but no OIDC_JWKS_KEY_<n> is set`                               | The set has no keys                                                  | Do [Task 1](#task-1-add-a-new-key) with the number that the pointer holds. Deploy.    |
| `OIDC_JWKS_KEY_2 must be one JWK, as JSON, with a kid`                                      | The value was not pasted in full, or is not the output of the script | Make a new key and write the secret again. Deploy.                                    |
| `OIDC_JWKS_KEY_1 and OIDC_JWKS_KEY_2 have the same kid`                                     | One value was pasted into two settings                               | Delete the one that the pointer does not name. Make a new key if you need it. Deploy. |
| `4 OIDC_JWKS_KEY_<n> keys are loaded - delete the old keys` (a warning, the service starts) | An old key was not deleted                                           | Do [Task 3](#task-3-delete-an-old-key) for each old key.                              |

The numbers and names in your log will be different. The cookie keys give
the same messages with `OIDC_COOKIE` in the names.

An error message gives the name of the setting. It never shows a key value.
