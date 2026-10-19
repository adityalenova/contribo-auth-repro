#!/usr/bin/env node
/**
 * Reproduction for Bug 1 in Contribo's GitHub sign-in: a provider registered without
 * credentials still builds an authorize URL, and that URL carries an empty client_id.
 *
 * The predicate below mirrors `isOAuthProviderConfigured()` from
 * src/lib/auth-providers.ts in the fix (PR #37). It is re-implemented here so the
 * behaviour can be exercised without the app's source tree.
 *
 * Run: node scripts/check-oauth-config.mjs
 */

const PLACEHOLDER_RE =
  /^(your_|change_me|placeholder|todo|tbd|xxx+|<.*>|\[.*\]|.*(id|secret)_here$)/i;

function credentialPresent(value) {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return false;
  return !PLACEHOLDER_RE.test(trimmed);
}

function isProviderConfigured(env, provider) {
  const keys =
    provider === 'github'
      ? ['AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET']
      : ['AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET'];
  return credentialPresent(env[keys[0]]) && credentialPresent(env[keys[1]]);
}

/** The URL Auth.js would hand the browser for an OAuth sign-in. */
function authorizeUrl(env, provider) {
  const idKey = provider === 'github' ? 'AUTH_GITHUB_ID' : 'AUTH_GOOGLE_ID';
  const clientId = (env[idKey] ?? '').trim();
  const origin = env.AUTH_URL ?? 'http://localhost:3000';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}/api/auth/callback/${provider}`,
    scope: provider === 'github' ? 'read:user user:email' : 'openid email profile',
    state: 'stub-state',
    code_challenge: 'stub-challenge',
    code_challenge_method: 'S256',
  });
  const host =
    provider === 'github'
      ? 'https://github.com/login/oauth/authorize'
      : 'https://accounts.google.com/o/oauth2/v2/auth';
  return `${host}?${params.toString()}`;
}

const cases = [
  {
    name: 'fully configured -> registered, URL is valid',
    env: { AUTH_GITHUB_ID: 'Ov23liRealLookingId', AUTH_GITHUB_SECRET: 'a'.repeat(40), AUTH_URL: 'http://localhost:3000' },
    expectRegistered: true,
  },
  {
    name: 'both blank -> must NOT register',
    env: { AUTH_GITHUB_ID: '', AUTH_GITHUB_SECRET: '' },
    expectRegistered: false,
  },
  {
    name: 'id set, secret missing (the original bug) -> must NOT register',
    env: { AUTH_GITHUB_ID: 'Ov23liRealLookingId', AUTH_GITHUB_SECRET: '' },
    expectRegistered: false,
  },
  {
    name: 'secret set, id missing -> must NOT register',
    env: { AUTH_GITHUB_ID: '', AUTH_GITHUB_SECRET: 'b'.repeat(40) },
    expectRegistered: false,
  },
  {
    name: 'template placeholders -> must NOT register',
    env: { AUTH_GITHUB_ID: 'your_client_id_here', AUTH_GITHUB_SECRET: 'CHANGE_ME' },
    expectRegistered: false,
  },
  {
    name: 'whitespace only -> must NOT register',
    env: { AUTH_GITHUB_ID: '   ', AUTH_GITHUB_SECRET: '\t\n' },
    expectRegistered: false,
  },
];

let failures = 0;

for (const testCase of cases) {
  const registered = isProviderConfigured(testCase.env, 'github');
  const url = authorizeUrl(testCase.env, 'github');
  const emptyClientId = new URL(url).searchParams.get('client_id') === '';

  // The invariant that matters: a provider the UI can offer must never produce a
  // request GitHub will bounce.
  const ok = registered === testCase.expectRegistered && (!registered || !emptyClientId);

  if (!ok) failures += 1;
  const label = ok ? 'PASS' : 'FAIL';
  console.log(`${label}  ${testCase.name}`);
  console.log(`      registered=${registered} expected=${testCase.expectRegistered} empty_client_id=${emptyClientId}`);
}

// Google shares the same code path; assert it is independent of GitHub's variables.
const googleOnly = { AUTH_GOOGLE_ID: 'abc.apps.googleusercontent.com', AUTH_GOOGLE_SECRET: 'g'.repeat(24) };
const googleRegistered = isProviderConfigured(googleOnly, 'google');
const githubInGoogleEnv = isProviderConfigured(googleOnly, 'github');
if (!googleRegistered || githubInGoogleEnv) failures += 1;
console.log(
  `${googleRegistered && !githubInGoogleEnv ? 'PASS' : 'FAIL'}  provider env vars are not cross-matched (google yes, github no)`,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll OAuth configuration checks passed.');
