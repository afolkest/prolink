#!/usr/bin/env node
import process from 'node:process';
import { writeFile } from 'node:fs/promises';
import { dumpConversation, sendReload } from '../src/server.js';
import { CONFIG } from '../src/config.js';
import {
  createPromptJob,
  listJobs,
  readJob,
  refreshJob,
  runQueue,
  startQueueRunner,
  waitForSubmission,
} from '../src/jobs.js';
import {
  formatLastAssistantJson,
  formatLastAssistantText,
  formatTranscriptJson,
  formatTranscriptMarkdown,
  normalizeConversation,
} from '../src/transcript.js';

const HELP = `prolink — send a prompt to a new ChatGPT chat from your terminal

Usage:
  prolink [options] "your prompt"                 # submit, print job + conversation
  echo "your prompt" | prolink [options]
  prolink --async [options] "your prompt"         # enqueue and print job id
  prolink --jobs                                  # list recent prompt jobs
  prolink --status <job-or-conversation>           # poll once; show state
  prolink --result <job-or-conversation>           # poll once; print if finished
  prolink --wait <job-or-conversation>             # poll until done; print reply
  prolink --dump <conversation-id> [--last] [--out transcript.md] [--format md|json]

Options:
  -m, --model <name>   Model label to select in the UI. Default: "${CONFIG.defaultModel}"
  -e, --effort <name>  Reasoning-effort label to select. Default: "${CONFIG.defaultEffort}"
      --no-model       Leave both model and effort as-is (use page defaults).
  -c, --continue <id>  Continue a previous conversation by id (printed after a
                       prior run). Default: start a new chat.
      --json           Print prompt/result/job output as JSON where supported.
      --async          Enqueue and return immediately with a job id, before the
                       conversation id is known.
      --jobs           List submitted messages chronologically.
      --status <id>    Poll once, then show status by job or conversation id.
      --result <id>    Poll once and print by job or conversation id if done.
      --wait <id>      Poll a job or conversation until done, then print it.
      --dump <id>      Dump a full conversation transcript by id/path.
      --last           With --dump, print only the latest assistant response.
      --out <file>     Write dump output to a file instead of stdout.
      --format <fmt>   Dump output format: md or json (default md). With --last,
                       md is plain response text.
      --port <n>       WebSocket bridge port (default ${CONFIG.port}).
      --timeout <sec>  Max seconds for --wait (default ${Math.round(CONFIG.responseTimeoutMs / 1000)}).
      --reload         Tell the extension to reload itself first (dev helper),
                       then run the prompt or dump if one was given.
      --debug          Print extension-side response diagnostics to stderr.
  -h, --help           Show this help.
`;

function parseArgs(argv) {
  const args = { _: [] };
  const valueFor = (flag, i) => {
    const value = argv[i + 1];
    if (value == null || value.startsWith('-')) {
      args.error = `${flag} requires a value.`;
      return [undefined, i];
    }
    return [value, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-m': case '--model': { const [v, n] = valueFor(a, i); if (args.error) return args; args.model = v; i = n; break; }
      case '-e': case '--effort': { const [v, n] = valueFor(a, i); if (args.error) return args; args.effort = v; i = n; break; }
      case '--no-model': args.noModel = true; break;
      case '-c': case '--continue': { const [v, n] = valueFor(a, i); if (args.error) return args; args.continue = v; i = n; break; }
      case '--json': args.json = true; break;
      case '--async': args.async = true; break;
      case '--jobs': args.jobs = true; break;
      case '--status': { const [v, n] = valueFor(a, i); if (args.error) return args; args.status = v; i = n; break; }
      case '--result': { const [v, n] = valueFor(a, i); if (args.error) return args; args.result = v; i = n; break; }
      case '--wait': { const [v, n] = valueFor(a, i); if (args.error) return args; args.wait = v; i = n; break; }
      case '--dump': { const [v, n] = valueFor(a, i); if (args.error) return args; args.dump = v; i = n; break; }
      case '--last': args.last = true; break;
      case '--out': { const [v, n] = valueFor(a, i); if (args.error) return args; args.out = v; i = n; break; }
      case '--format': { const [v, n] = valueFor(a, i); if (args.error) return args; args.format = v; i = n; break; }
      case '--port': { const [v, n] = valueFor(a, i); if (args.error) return args; args.port = parseInt(v, 10); i = n; break; }
      case '--timeout': { const [v, n] = valueFor(a, i); if (args.error) return args; args.timeout = parseInt(v, 10) * 1000; i = n; break; }
      case '--reload': args.reload = true; break;
      case '--debug': args.debug = true; break;
      case '--run-queue': args.runQueue = true; break; // internal background runner
      case '-h': case '--help': args.help = true; break;
      default: args._.push(a);
    }
  }
  return args;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

// A conversation handle is either a bare id ("<uuid>") or a path
// ("g/<gizmo>/c/<uuid>" for a GPT/Project chat). Validate by the URL it becomes
// rather than a fixed charset: pin host + path shape and reject traversal. This
// is a superset of what the content script can capture (segments are
// `[^/?#]+`), so we never refuse a handle the tool itself printed, while still
// guaranteeing the resulting URL stays on chatgpt.com.
function validConversation(s) {
  if (typeof s !== 'string' || !s || s.length > 200) return false;
  if (s.includes('..') || s.includes('//') || s.includes('\\') || /[?#\s]/.test(s)) return false;
  let u;
  try { u = new URL(s.includes('/') ? `https://chatgpt.com/${s}` : `https://chatgpt.com/c/${s}`); }
  catch { return false; }
  return u.origin === 'https://chatgpt.com'
    && (/^\/c\/[^/]+$/.test(u.pathname) || /^\/g\/[^/]+\/c\/[^/]+$/.test(u.pathname));
}

function snippet(text, max = 72) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function jobSummary(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.statusStage || '',
    model: job.model || '',
    effort: job.effort || '',
    conversation: job.resultConversation || job.conversation || '',
    createdAt: job.createdAt || '',
    startedAt: job.startedAt || '',
    submittedAt: job.submittedAt || '',
    finishedAt: job.finishedAt || '',
    updatedAt: job.updatedAt || '',
    attempts: job.attempts || 0,
    error: job.error || '',
    prompt: snippet(job.prompt || ''),
  };
}

function printJobs(jobs, { json = false } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify(jobs.map(jobSummary), null, 2) + '\n');
    return;
  }
  if (!jobs.length) {
    process.stdout.write('No prolink jobs yet.\n');
    return;
  }
  for (const job of jobs) {
    const s = jobSummary(job);
    const when = s.submittedAt || s.createdAt;
    const detail = s.status === 'running' && s.stage ? ` (${s.stage})` : '';
    process.stdout.write(`${s.id}\t${s.status}${detail}\t${when}\t${s.conversation || '-'}\t${s.prompt}\n`);
  }
}

function printStatus(job, { json = false } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify(jobSummary(job), null, 2) + '\n');
    return;
  }
  const s = jobSummary(job);
  process.stdout.write(`job: ${s.id}\n`);
  process.stdout.write(`status: ${s.status}\n`);
  if (s.stage && s.stage !== s.status) process.stdout.write(`stage: ${s.stage}\n`);
  if (s.model) process.stdout.write(`model: ${s.model}\n`);
  if (s.effort) process.stdout.write(`effort: ${s.effort}\n`);
  if (s.conversation) process.stdout.write(`conversation: ${s.conversation}\n`);
  if (s.createdAt) process.stdout.write(`created: ${s.createdAt}\n`);
  if (s.startedAt) process.stdout.write(`started: ${s.startedAt}\n`);
  if (s.submittedAt) process.stdout.write(`submitted: ${s.submittedAt}\n`);
  if (s.finishedAt) process.stdout.write(`finished: ${s.finishedAt}\n`);
  if (s.attempts) process.stdout.write(`attempts: ${s.attempts}\n`);
  if (s.error) process.stdout.write(`error: ${s.error}\n`);
  if (s.prompt) process.stdout.write(`prompt: ${s.prompt}\n`);
}

function printSubmitted(job, { json = false } = {}) {
  const conversation = job.resultConversation || job.conversation || '';
  if (json) {
    process.stdout.write(JSON.stringify({ job: job.id, status: job.status, conversation }) + '\n');
  } else {
    process.stdout.write(`${job.id}\n`);
    if (conversation) process.stderr.write(`… conversation: ${conversation}\n`);
  }
}

function printPromptResult(job, { json = false, pendingIsError = false } = {}) {
  const conversation = job.resultConversation || job.conversation || '';
  if (job.status === 'done') {
    if (json) {
      process.stdout.write(JSON.stringify({ text: job.text || '', conversation }) + '\n');
    } else {
      process.stdout.write((job.text || '') + '\n');
      if (conversation) process.stderr.write(`… conversation: ${conversation}\n`);
    }
    return 0;
  }
  if (job.status === 'error') {
    if (json) {
      process.stdout.write(JSON.stringify({ error: job.error || 'job failed', conversation }) + '\n');
    } else {
      process.stderr.write(`Error: ${job.error || 'job failed'}\n`);
      if (conversation) process.stderr.write(`… conversation: ${conversation}\n`);
    }
    return 1;
  }
  const message = `Job ${job.id} is ${job.status}${job.statusStage ? ` (${job.statusStage})` : ''}.`;
  if (json) process.stdout.write(JSON.stringify({ job: job.id, status: job.status, stage: job.statusStage || '' }) + '\n');
  else process.stderr.write(`${message} Use --wait ${job.id} to wait or --status ${job.id} to poll again.\n`);
  return pendingIsError ? 1 : 0;
}

async function readRequiredJob(id) {
  let job = null;
  try { job = await readJob(id); }
  catch (err) {
    if (!validConversation(id)) throw err;
  }
  if (!job && validConversation(id)) {
    const matches = (await listJobs({ limit: 0 })).filter((candidate) =>
      (candidate.resultConversation || candidate.conversation || '') === id);
    job = matches[matches.length - 1] || null;
  }
  if (!job) throw new Error(`job not found: ${id}`);
  return job;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilSubmitted(id, { timeoutMs = 0, showProgress = true } = {}) {
  startQueueRunner();
  let lastVisible = '';
  return waitForSubmission(id, {
    pollMs: 250,
    timeoutMs,
    onUpdate: (j) => {
      if (!showProgress || j.status === 'submitted' || j.status === 'done' || j.status === 'error') return;
      const visible = j.status === 'running' ? (j.statusStage || 'running') : j.status;
      if (visible && visible !== lastVisible) {
        lastVisible = visible;
        process.stderr.write(`… ${visible}\n`);
      }
    },
  });
}

async function waitAndPrint(id, { json = false, waitTimeoutMs = 0 } = {}) {
  const started = Date.now();
  let job = await waitUntilSubmitted(id, { timeoutMs: waitTimeoutMs });
  while (job.status === 'submitted') {
    try {
      job = await refreshJob(id);
    } catch (err) {
      // A submission runner may briefly own the single extension bridge while
      // it dispatches another queued prompt. Generations are still concurrent;
      // wait for that short transaction and retry this endpoint poll.
      if (!/Port \d+ is already in use/.test(String((err && err.message) || err))) throw err;
      await sleep(500);
      continue;
    }
    if (job.status !== 'submitted') break;
    if (waitTimeoutMs > 0 && Date.now() - started >= waitTimeoutMs) {
      throw new Error(`Timed out waiting for job ${id}; ChatGPT is still generating. Use --status ${id} or --wait ${id} to check it later.`);
    }
    await sleep(3000);
  }
  const code = printPromptResult(job, { json, pendingIsError: true });
  if (code) process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  if (args.error) { process.stderr.write(`Error: ${args.error}\n`); process.exit(2); }
  if (args.runQueue) { await runQueue(); return; }

  const port = Number.isFinite(args.port) ? args.port : CONFIG.port;

  if (args.jobs) {
    printJobs(await listJobs(), { json: !!args.json });
    return;
  }
  if (args.status) {
    try {
      let job = await readRequiredJob(args.status);
      if (job.status === 'submitted') job = await refreshJob(job.id);
      printStatus(job, { json: !!args.json });
    }
    catch (err) { process.stderr.write(`Error: ${err.message}\n`); process.exit(1); }
    return;
  }
  if (args.result) {
    try {
      let job = await readRequiredJob(args.result);
      if (job.status === 'submitted') job = await refreshJob(job.id);
      const code = printPromptResult(job, { json: !!args.json, pendingIsError: true });
      if (code) process.exit(code);
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    return;
  }
  if (args.wait) {
    try {
      const job = await readRequiredJob(args.wait);
      await waitAndPrint(job.id, { json: !!args.json, waitTimeoutMs: Number.isFinite(args.timeout) ? args.timeout : CONFIG.responseTimeoutMs });
    }
    catch (err) { process.stderr.write(`Error: ${err.message}\n`); process.exit(1); }
    return;
  }

  if (args.reload) {
    try {
      await sendReload({ host: CONFIG.host, port, connectTimeoutMs: CONFIG.connectTimeoutMs, token: CONFIG.token });
      process.stderr.write('… extension reloaded\n');
    } catch (err) {
      process.stderr.write(`Error (reload): ${err.message}\n`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1200)); // let the port free + worker restart
  }

  // Validate conversation handles up front (see validConversation). Before the
  // prompt check so a prompt accidentally consumed by -c/--dump gives a clear error.
  const continueId = args.continue;
  if ('continue' in args && !validConversation(continueId)) {
    process.stderr.write(`Error: invalid conversation id ${JSON.stringify(continueId || '')} — use the id printed after a previous run.\n`);
    process.exit(2);
  }

  const dumpId = args.dump;
  if (args.last && !('dump' in args)) {
    process.stderr.write('Error: --last requires --dump <conversation-id>.\n');
    process.exit(2);
  }
  if ('dump' in args) {
    if (args.async) {
      process.stderr.write('Error: --async is for prompt mode and cannot be combined with --dump.\n');
      process.exit(2);
    }
    if (!validConversation(dumpId)) {
      process.stderr.write(`Error: invalid conversation id ${JSON.stringify(dumpId || '')} — use the id printed after a previous run.\n`);
      process.exit(2);
    }
    if ('continue' in args) {
      process.stderr.write('Error: --dump cannot be combined with --continue.\n');
      process.exit(2);
    }
    if (args._.length) {
      process.stderr.write('Error: --dump does not take a prompt argument.\n');
      process.exit(2);
    }
    if (args.json) {
      process.stderr.write('Error: --json is for prompt mode; use --format json with --dump.\n');
      process.exit(2);
    }
    const format = (args.format || 'md').toLowerCase();
    if (format !== 'md' && format !== 'json') {
      process.stderr.write('Error: --format must be "md" or "json".\n');
      process.exit(2);
    }

    try {
      const { data, conversation } = await dumpConversation({
        conversation: dumpId,
        host: CONFIG.host,
        port,
        connectTimeoutMs: CONFIG.connectTimeoutMs,
        responseTimeoutMs: Number.isFinite(args.timeout) ? args.timeout : CONFIG.responseTimeoutMs,
        token: CONFIG.token,
        onStatus: (s) => { if (s) process.stderr.write(`… ${s}\n`); },
      });
      const transcript = normalizeConversation(data, { conversation: conversation || dumpId });
      const output = args.last
        ? (format === 'json' ? formatLastAssistantJson(transcript) : formatLastAssistantText(transcript))
        : (format === 'json' ? formatTranscriptJson(transcript) : formatTranscriptMarkdown(transcript));
      if (args.out) {
        await writeFile(args.out, output, 'utf8');
        process.stderr.write(`… wrote ${args.last ? 'response' : 'transcript'}: ${args.out}\n`);
      } else {
        process.stdout.write(output);
      }
      return;
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
  }

  let prompt = args._.join(' ').trim();
  if (!prompt) prompt = await readStdin();
  if (!prompt) {
    if (args.reload) return; // reload-only invocation
    process.stderr.write('Error: no prompt provided.\n\n' + HELP);
    process.exit(2);
  }

  const model = args.noModel ? '' : (args.model || CONFIG.defaultModel);
  const effort = args.noModel ? '' : (args.effort || CONFIG.defaultEffort);

  let job;
  try {
    job = await createPromptJob({
      prompt,
      model,
      effort,
      conversation: continueId || '',
      host: CONFIG.host,
      port,
      connectTimeoutMs: CONFIG.connectTimeoutMs,
      responseTimeoutMs: Number.isFinite(args.timeout) ? args.timeout : CONFIG.responseTimeoutMs,
      debug: !!args.debug,
    });
    startQueueRunner();
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  if (args.async) {
    printSubmitted(job, { json: !!args.json });
    return;
  }

  try {
    const submitted = await waitUntilSubmitted(job.id, {
      timeoutMs: CONFIG.connectTimeoutMs + 45_000,
    });
    if (submitted.status === 'error') {
      const code = printPromptResult(submitted, { json: !!args.json });
      if (code) process.exit(code);
      return;
    }
    printSubmitted(submitted, { json: !!args.json });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
