# Contribo auth repro harness

A small, self-contained reproduction of the two GitHub sign-in bugs fixed in
[subhranshudash13-dotcom/Contribo#37](https://github.com/subhranshudash13-dotcom/Contribo/pull/37),
plus scripts that prove the fixes hold. Nothing here needs Contribo's source tree or a
deployed app — it talks to a plain MongoDB and a plain HTTP origin.

Both bugs made "Continue with GitHub" fail with an opaque error page.

## Bug 1 — providers registered without credentials

Contribo spread the GitHub and Google providers into `auth.ts` unconditionally. When a
deployment has no `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` (or a placeholder value),
Auth.js still advertises the provider, so the button on the login page posts to a
callback that builds an authorize URL with an empty `client_id`. GitHub rejects it and
the user lands on `?error=Configuration` with no explanation.

`scripts/check-oauth-config.mjs` reproduces the URL-building decision in isolation and
asserts that a provider is registered only when both halves of the credential pair are
present and are not placeholders.

```bash
node scripts/check-oauth-config.mjs
```

No MongoDB or running app required.

## Bug 2 — `E11000 duplicate key: { email: null }`

Contribo indexed `users.email` as `unique: true, sparse: true`. `sparse` only omits
documents where the field is *absent*, but the NextAuth MongoDB adapter writes
`email: null` for an OAuth profile with no public email — which a GitHub account may
legitimately have. All of those documents share one null key, so the **second** such
sign-in dies on a duplicate-key error that Auth.js reports as a configuration problem.

`scripts/repro-null-email.mjs` runs both halves against a real mongod: it recreates the
legacy index, shows the second email-less insert fail, then applies the partial unique
index used by the fix and shows both inserts succeed while duplicate real emails are
still rejected.

```bash
# start any mongod, e.g. `mongod --port 27017`, or reuse the app's
MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/repro-null-email.mjs
```

The index fix itself is:

```js
await collection.createIndex(
  { email: 1 },
  {
    unique: true,
    name: 'email_unique_when_present',
    partialFilterExpression: { email: { $type: 'string' } },
  }
)
```

Uniqueness applies only to real strings, and the legacy `email_1` index is dropped
*after* the replacement is built, so there is no window in which two sign-ups could
claim the same address.

## HTTP smoke test

`tools/smoke_test.py` checks a running Contribo instance (or any next-auth v5 app)
from the outside: which providers the server actually advertises, and that the login
page shows neutral copy for `Configuration` and OAuth-specific copy for the real
Auth.js OAuth error names instead of guessing.

```bash
BASE_URL=http://localhost:3000 python3 tools/smoke_test.py
```

## One command

```bash
./run.sh
```

Runs everything that has the prerequisites it needs and skips the rest with a reason.

## Recorded output

[docs/verification-log.md](docs/verification-log.md) holds the actual output from each of
the three checks, plus the end-to-end sign-in that was run against Contribo itself — use
it as the baseline when a check starts behaving differently.

## Notes

- The harness never prints a client secret; `check-oauth-config.mjs` works on fake values.
- `MONGODB_DB` defaults to `contribo_auth_repro` and the script drops its own
  `users_probe` collection, so it is safe to point at a scratch database. Never point it
  at production.
