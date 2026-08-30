# Conversation transcript dump checklist

Goal: add an endpoint-backed transcript dump command that exports a full ChatGPT conversation by id/path without relying on DOM virtualization.

## Slice 1 — CLI/bridge/parser foundation

Scope:
- Add a pure transcript module that normalizes ChatGPT conversation JSON into ordered turns and formats Markdown/JSON.
- Add a `dumpConversation` WebSocket bridge path in the CLI server, analogous to `runPrompt`.
- Add CLI flags for dump mode: `--dump <conversation-id>`, `--out <file>`, and `--format md|json`.
- Add unit/integration coverage with fake extension messages and parser fixtures.

Non-goals:
- The real Chrome extension does not need to fetch ChatGPT endpoints in this slice.
- No browser/UI transcript scraping fallback.

Status: complete

## Slice 2 — Extension endpoint fetch and user docs

Scope:
- Teach the extension service worker to handle dump jobs by fetching ChatGPT's conversation endpoint from the logged-in browser context.
- Include robust auth fallback: read `/api/auth/session` for an access token when available, while also using browser cookies via `credentials: 'include'`.
- Return clear errors for missing auth, unavailable conversations, endpoint drift, or malformed responses.
- Document usage, output formats, and endpoint-drift caveats in README/USER_GUIDE.
- Extend tests where practical without requiring a real browser.

Non-goals:
- No DOM scroll-and-merge fallback.
- No bulk export/history listing.
- No media/file attachment download.

Status: complete
