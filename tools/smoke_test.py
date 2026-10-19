#!/usr/bin/env python3
"""Outside-in checks for a running Contribo (or any next-auth v5) instance.

Confirms the two login-page behaviours introduced in PR #37:
  * the server only advertises providers it can actually complete
  * error copy does not guess at a cause the client cannot know

Run:
    BASE_URL=http://localhost:3000 python3 tools/smoke_test.py
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

BASE_URL = (sys.argv[1] if len(sys.argv) > 1 else None) or "http://localhost:3000"
BASE_URL = BASE_URL.rstrip("/")
TIMEOUT_SECONDS = 10

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    if detail:
        print(f"      {detail}")
    if not ok:
        failures.append(label)


def get(path: str) -> tuple[int, str]:
    with urllib.request.urlopen(BASE_URL + path, timeout=TIMEOUT_SECONDS) as response:
        return response.status, response.read().decode("utf-8", "replace")


def main() -> int:
    print(f"Target: {BASE_URL}\n")

    # 1. Provider list must be the ground truth the UI defers to.
    try:
        status, body = get("/api/auth/providers")
        providers = json.loads(body)
    except (urllib.error.URLError, TimeoutError) as err:
        print(f"Cannot reach {BASE_URL} ({err}). Start the app, then re-run.")
        return 2
    except json.JSONDecodeError as err:
        print(f"/api/auth/providers returned non-JSON: {err}")
        return 2

    check("provider endpoint answers 200", status == 200, f"status={status}")
    check(
        "no provider is advertised with an empty id",
        all(entry.get("id") for entry in providers.values()),
        "advertised: " + ", ".join(sorted(providers)),
    )
    github = "github" in providers
    print(f"      github advertised: {github} (set AUTH_GITHUB_ID/AUTH_GITHUB_SECRET to enable)")

    # 2. `Configuration` is Auth.js's catch-all for server-side config failures, so the
    #    login page must not promise that another sign-in method still works.
    _, html = get("/login?error=Configuration")
    neutral = "Sign-in is not configured correctly on this deployment" in html
    check("Configuration error copy is neutral", neutral)
    check(
        "Configuration error copy does not claim a working fallback",
        "Email and password sign-in still works" not in html,
    )

    # 3. Real Auth.js OAuth error names (there is no `OAuthCallback` code in @auth/core).
    for code in ("OAuthCallbackError", "OAuthSignInError", "OAuthProfileParseError"):
        _, oauth_html = get(f"/login?error={code}")
        check(
            f"{code} renders the OAuth-specific message",
            "The sign-in with that provider could not be completed" in oauth_html,
        )

    # 4. Unknown codes keep the generic message rather than lying about the cause.
    _, unknown_html = get("/login?error=SomethingUnexpected")
    check("unknown error keeps the generic message", "Authentication error occurred" in unknown_html)

    # 5. The social buttons are fail-closed: the server-rendered shell must not contain
    #    the social block at all, because it only appears once the client has confirmed
    #    the provider list. (Without this, a half-configured deployment would render a
    #    GitHub button that dead-ends on an Auth.js error page.)
    _, login_html = get("/login")
    check(
        "social block is absent from the server-rendered HTML",
        "or continue with" not in login_html,
        "the block is added client-side after /api/auth/providers is confirmed",
    )
    check(
        "the unverified-provider notice markup is not pre-rendered",
        "could not be verified" not in login_html,
    )

    if failures:
        print(f"\n{len(failures)} check(s) failed: " + ", ".join(failures))
        return 1
    print("\nAll HTTP smoke checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
