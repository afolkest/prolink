# Conversation transcript dump execution log

## 2026-06-28 — Slice 2: Extension endpoint fetch

- Decision: Retry the conversation endpoint once without an Authorization header if the bearer-token request returns 401/403.
- Context: The implementation can read `/api/auth/session`, but that endpoint is optional and cookie-auth may still be valid even when an access token is absent or stale.
- Alternatives considered: always require a bearer token; use cookie-only only; bearer-first with cookie-only fallback.
- Rationale: Bearer-first matches ChatGPT's internal endpoint behavior when available, while cookie-only fallback preserves the user's logged-in browser session if the session token path drifts.
- Product/architecture impact: Improves dump reliability without adding DOM scraping or widening to bulk export.
- Reversibility: easy; remove the fallback if the endpoint later requires bearer-only auth.
- Follow-up: none.
