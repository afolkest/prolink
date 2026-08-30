# prolink

Send a prompt to a **new ChatGPT chat** (or continue an existing one with `-c`)
from your terminal, then poll or retrieve the response later. Submission is a
short browser transaction; after ChatGPT assigns a conversation and user-message
id, generation continues independently, so many different conversations can run
at once. You can also dump a full conversation transcript by id. It drives your *real, logged-in* Chrome via
a small browser extension, so it uses your ChatGPT Pro subscription (not the
paid API) and looks like normal browser traffic.

```
$ prolink "explain the borrow checker like I'm five"
… extension connected
… opening new chat
… sending prompt
job-mxyz-1234abcd
… conversation: 01234567-89ab-cdef-0123-456789abcdef

$ prolink --wait job-mxyz-1234abcd
The borrow checker is like a librarian for your toys...
```

## How it works

```
CLI ──▶ local job file ──▶ submit runner ──ws://127.0.0.1:8767──▶ extension ──▶ chatgpt.com
 ▲                         │                                       │
 └──── status/result ──────┴──── conversation endpoint polling ◀───┘
```

1. The CLI writes a prompt job under `~/.prolink/jobs` and starts the submission runner.
2. The extension opens the requested chat, selects the model and reasoning
   effort, types the prompt, and returns the accepted conversation id plus exact
   user-message id.
3. The runner records that identity and immediately submits the next queued job.
   It does not wait for the previous answer, so generations overlap.
4. `--status`, `--result`, and `--wait` fetch the conversation endpoint and bind
   the answer to that exact user-message id. An older assistant answer cannot
   satisfy a newer job.

For `--dump`, the same authenticated extension fetches ChatGPT's internal
conversation JSON endpoint directly and the CLI formats the current conversation
branch as Markdown or JSON. This avoids DOM virtualization/scrolling issues.

## Setup

**1. Install CLI deps**

```bash
cd prolink
npm install
npm link        # optional: puts `prolink` on your PATH (or just use `node bin/prolink.js`)
```

**2. Load the extension** (one time)

- Open `chrome://extensions`, enable **Developer mode** (top right).
- **Load unpacked** → select the `extension/` folder.
- Make sure you're **logged into chatgpt.com** in that Chrome profile.

That's it. Chrome must be running for the CLI to work.

## Usage

```bash
prolink "your prompt here"             # defaults: 5.6 Sol / Medium (see src/config.js)
echo "long prompt from a file" | prolink
prolink -m "5.6 Terra" -e "High" "..." # select model and effort by visible picker labels
prolink --effort "Extra High" "..."    # keep default model, change reasoning effort
prolink --no-model "..."               # leave both controls at the page defaults
prolink --json "..."                   # machine-readable submission identity
prolink --async "..."                  # enqueue and print a job id immediately
prolink --jobs                          # list messages chronologically with UUIDs
prolink --status <job-or-uuid>          # poll once; inspect state
prolink --result <job-or-uuid>          # poll once; print if done
prolink --wait <job-or-uuid>            # poll until done and print the answer
prolink --wait <job> --timeout 300      # override the wait cap, seconds
prolink --dump <id> > transcript.md     # dump full transcript as Markdown
prolink --dump <id> --last              # print only the latest assistant response
prolink --dump <id> --format json --out transcript.json
```

Each accepted submission prints its local job id to stdout and conversation
handle to stderr (`… conversation: <id>`); pass
it back to continue that thread:

```bash
prolink -c <id> "follow-up question"   # submit another turn to this conversation
```

Wait for the current turn to finish before sending a follow-up to the same
conversation. Different conversation ids can generate concurrently. `--wait`
and a completed `--result` print response text only, so they pipe cleanly.
Progress and conversation handles go to stderr; use `--json` for structured
submission/result output. With `--async`, stdout is the queued job id before its
conversation id is known.

Transcript dumps default to Markdown on stdout. Add `--last` to print only the
latest assistant response from the current conversation branch. Use
`--format json` for structured output, and `--out <file>` to write either format
to disk. Dumping uses the same conversation handle printed by previous runs,
including GPT/Project paths like `g/<gizmo>/c/<id>`.

Only the brief browser submission transactions are serialized around the single
local extension bridge. They move on as soon as ChatGPT acknowledges each user
message; the long-running generations are not serialized.

## Configuration

Edit `src/config.js` (CLI) — port, timeouts, and the default model/effort labels.
The extension's copy of the port lives in `extension/background.js`; keep them
in sync.

## Security and privacy

- The extension can read ChatGPT conversations available to the signed-in
  Chrome profile. It uses a session access token only inside the extension and
  does not persist that token or send it to the CLI.
- The bridge listens only on `127.0.0.1`, accepts the pinned Prolink extension
  origin, and requires a token handshake. The token shipped in this public
  source tree is not a defense against malicious software already running on
  your computer; the local machine is the trust boundary.
- Prompt jobs and any retrieved response text are stored under
  `~/.prolink/jobs` as private-mode JSON files. Remove those files if you do not
  want to retain local prompt history.
- ChatGPT's web UI and internal conversation endpoint are unsupported
  integration surfaces and can change without notice. Prolink fails closed when
  it cannot verify a model, effort, submission, or response identity.

## Known rough edges (this is a v0 scaffold)

- **Picker selection is best-effort.** Available models and effort labels can
  vary by account and can change. The current defaults are `5.6 Sol` and
  `Medium`; override them with `-m "..."` and `-e "..."` (or update
  `defaultModel` / `defaultEffort`) using the visible picker labels.
- **Selectors drift.** ChatGPT reskins occasionally; when something breaks it's
  almost always a one-line fix in the `SEL` block at the top of
  `extension/content.js`.
- **Cold start lag.** After a long idle, the MV3 service worker is asleep; its
  keepalive alarm revives it within ~30s, so the first call after a break may
  wait a bit. Subsequent calls are immediate.
- **Transcript dump endpoint drift.** `--dump` uses ChatGPT's undocumented
  `backend-api/conversation/<id>` response. If OpenAI changes that endpoint or
  its JSON shape, prolink should fail with an endpoint/JSON error instead of
  returning a partial DOM scrape.
- **Submission steals focus.** ChatGPT currently defers parts of its composer
  and model picker in background tabs, so Prolink opens the submission tab as
  active. Generation continues independently after ChatGPT accepts the prompt.

## License

MIT — see [LICENSE](LICENSE).
