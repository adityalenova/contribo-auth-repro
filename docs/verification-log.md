# Verification log

Output captured while building the harness, so the expected results are on the record and
a future run can be compared against them. Environment: macOS arm64, Node 22,
mongod 8.2.6 (started by Contribo's dev script), Contribo running at `localhost:3000`
with GitHub + credentials providers configured.

## `node scripts/check-oauth-config.mjs`

```
PASS  fully configured -> registered, URL is valid
      registered=true expected=true empty_client_id=false
PASS  both blank -> must NOT register
      registered=false expected=false empty_client_id=true
PASS  id set, secret missing (the original bug) -> must NOT register
      registered=false expected=false empty_client_id=false
PASS  secret set, id missing -> must NOT register
      registered=false expected=false empty_client_id=true
PASS  template placeholders -> must NOT register
      registered=false expected=false empty_client_id=false
PASS  whitespace only -> must NOT register
      registered=false expected=false empty_client_id=true
PASS  provider env vars are not cross-matched (google yes, github no)

All OAuth configuration checks passed.
```

The third case is the original bug: an id without a secret used to be enough to register
the provider.

## `node scripts/repro-null-email.mjs`

```
Connected to mongodb://127.0.0.1:27017 (database contribo_auth_repro, collection users_probe)

[1] Legacy index: unique + sparse on users.email
    - first email-less account inserted (11111111)
    - second email-less account REJECTED (code 11000): E11000 duplicate key error collection: contribo_auth_repro.users_probe index: email_1 dup ...
    => bug reproduced: uniqueness applies to the shared null key

[2] Fixed index: unique only when the email is a string
    - two email-less accounts both inserted
    - duplicate real email REJECTED (dev@example.com) as it should be
    final index set: _id_ | email_unique_when_present

All expectations met: the legacy index breaks email-less GitHub sign-ins, the partial index does not.
```

Stage [2] also demonstrates that the replacement index can be created while `email_1`
still exists — two indexes over the same `{ email: 1 }` key are legal in MongoDB as long
as the names differ, which is what makes the build-before-drop ordering in
`scripts/setup-indexes.js` safe.

## `python3 tools/smoke_test.py http://localhost:3000`

```
Target: http://localhost:3000

PASS  provider endpoint answers 200
      status=200
PASS  no provider is advertised with an empty id
      advertised: credentials, github
      github advertised: True (set AUTH_GITHUB_ID/AUTH_GITHUB_SECRET to enable)
PASS  Configuration error copy is neutral
PASS  Configuration error copy does not claim a working fallback
PASS  OAuthCallbackError renders the OAuth-specific message
PASS  OAuthSignInError renders the OAuth-specific message
PASS  OAuthProfileParseError renders the OAuth-specific message
PASS  unknown error keeps the generic message
PASS  social block is absent from the server-rendered HTML
      the block is added client-side after /api/auth/providers is confirmed
PASS  the unverified-provider notice markup is not pre-rendered

All HTTP smoke checks passed.
```

## End-to-end sign-in

With the fix applied in Contribo itself, a real GitHub PKCE flow was completed in a
browser: `/login` → provider lookup confirms `github` → authorize on github.com →
callback → `/dashboard`, signed in as a GitHub account that does have a public email.
Email-less accounts are covered by stage [2] above rather than by a live account.
