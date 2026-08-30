# prolink — message ChatGPT from the terminal (drives your logged-in Chrome / Pro plan)

- **Submit:** `prolink "your message"` — submits the message, then prints its local job id and ChatGPT conversation id without waiting for generation. Defaults to **5.6 Sol / Medium**; use `-m "5.6 Terra" -e "High"` (or other visible picker labels) to change either control.
- **Async enqueue:** `prolink --async "your message"` prints a job id immediately, before submission has acquired a conversation id.
- **Jobs:** `prolink --jobs` lists messages chronologically with their conversation ids. `prolink --status <job-or-id>` polls once, `--result` prints a finished answer, and `--wait` polls until it can print the answer.
- **Output:** submit → job id on stdout and conversation id on stderr; `--wait`/completed `--result` → reply on stdout. Add `--json` for structured output.
- **Parallelism:** submission clicks use one short queue, but ChatGPT generations in different conversations overlap. A slow high-effort answer no longer blocks later fresh-chat submissions.
- **Continue:** after the current turn finishes, `prolink -c <id> "follow-up message"` submits the next turn to the same conversation.
- **Dump transcript:** `prolink --dump <id> > transcript.md`; add `--last` to print only the latest assistant response; use `--format json --out transcript.json` for structured output.
- **Notes:** Chrome running + logged into chatgpt.com. `--no-model` leaves both model and effort at the page defaults. Job files live in `~/.prolink/jobs` as plain JSON containing submission identities and any polled response text. Bad `-m`/`-e` labels → prolink lists choices it observed. Status/result/dump use ChatGPT's internal conversation endpoint, so endpoint drift may require a prolink patch.
