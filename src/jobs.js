import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { dumpConversation, runPrompt } from './server.js';
import { inspectSubmission } from './transcript.js';

const STATE_DIR_ENV = 'PROLINK_STATE_DIR';
const TERMINAL = new Set(['done', 'error']);
const SUBMISSION_SETTLED = new Set(['submitted', 'done', 'error']);
const DEFAULT_IDLE_GRACE_MS = 1000;
const DEFAULT_LOCK_WAIT_MS = 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stateDir() {
  return process.env[STATE_DIR_ENV] || path.join(os.homedir(), '.prolink');
}

export function jobsDir() {
  return path.join(stateDir(), 'jobs');
}

function lockDir() {
  return path.join(stateDir(), 'runner.lock');
}

function assertJobId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) {
    throw new Error(`invalid job id ${JSON.stringify(id || '')}`);
  }
}

function jobPath(id) {
  assertJobId(id);
  return path.join(jobsDir(), `${id}.json`);
}

async function ensureDirs() {
  await fsp.mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await fsp.mkdir(jobsDir(), { recursive: true, mode: 0o700 });
  // Job files contain prompt/response text. Tighten permissions when possible,
  // while tolerating filesystems that ignore POSIX modes.
  await fsp.chmod(stateDir(), 0o700).catch(() => {});
  await fsp.chmod(jobsDir(), 0o700).catch(() => {});
}

async function readJson(file) {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text);
}

async function atomicWriteJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function newJobId() {
  return `job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function errorMessage(err) {
  return String((err && err.message) || err || 'Unknown error');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

export function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

export async function writeJob(job) {
  if (!job || !job.id) throw new Error('job is missing an id');
  await ensureDirs();
  await atomicWriteJson(jobPath(job.id), job);
  return job;
}

export async function readJob(id) {
  try {
    return await readJson(jobPath(id));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function updateJob(id, patchOrFn) {
  const current = await readJob(id);
  if (!current) throw new Error(`job not found: ${id}`);
  const patch = typeof patchOrFn === 'function' ? patchOrFn(current) : patchOrFn;
  const next = { ...current, ...patch, updatedAt: nowIso() };
  await writeJob(next);
  return next;
}

export async function createPromptJob({
  prompt,
  model = '',
  effort = '',
  conversation = '',
  host = CONFIG.host,
  port = CONFIG.port,
  connectTimeoutMs = CONFIG.connectTimeoutMs,
  responseTimeoutMs = CONFIG.responseTimeoutMs,
  debug = false,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');
  const createdAt = nowIso();
  const job = {
    id: newJobId(),
    kind: 'prompt',
    status: 'queued',
    statusStage: 'queued',
    prompt,
    model,
    effort,
    conversation,
    host,
    port,
    connectTimeoutMs,
    responseTimeoutMs,
    debug: !!debug,
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
  await writeJob(job);
  return job;
}

export async function listJobs({ limit = 50 } = {}) {
  await ensureDirs();
  const names = await fsp.readdir(jobsDir()).catch((err) => {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  });
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const job = await readJson(path.join(jobsDir(), name));
      if (job && job.id) jobs.push(job);
    } catch {
      // Ignore partially-written/corrupt files in listing; direct lookup will
      // surface parse errors if the user asks for that specific id.
    }
  }
  jobs.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return Number.isFinite(limit) && limit > 0 ? jobs.slice(-limit) : jobs;
}

async function nextRunnableJob() {
  const jobs = await listJobs({ limit: 0 });
  jobs.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  // Resume an interrupted running job before starting any queued work. The
  // extension/content de-dupe is keyed by this job id, so re-handing the same id
  // is the safe recovery path if a runner died after submitting to ChatGPT.
  const staleRunning = jobs.find((job) =>
    job.kind === 'prompt' &&
    job.status === 'running' &&
    Number.isInteger(job.runnerPid) &&
    !pidAlive(job.runnerPid)
  );
  if (staleRunning) return staleRunning;
  return jobs.find((job) => job.kind === 'prompt' && job.status === 'queued') || null;
}

async function removeLockIfStale() {
  let info = null;
  try { info = await readJson(path.join(lockDir(), 'pid.json')); }
  catch { /* handled below */ }

  if (info && pidAlive(info.pid)) return false;

  // If the lock exists but has no readable pid, only remove it after a short
  // grace period so we do not race a runner between mkdir() and pid write.
  if (!info) {
    try {
      const st = await fsp.stat(lockDir());
      if (Date.now() - st.mtimeMs < 5000) return false;
    } catch {
      return true;
    }
  }

  await fsp.rm(lockDir(), { recursive: true, force: true });
  return true;
}

async function acquireRunnerLock({ waitMs = DEFAULT_LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  await fsp.mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await fsp.chmod(stateDir(), 0o700).catch(() => {});

  for (;;) {
    try {
      await fsp.mkdir(lockDir());
      await atomicWriteJson(path.join(lockDir(), 'pid.json'), { pid: process.pid, startedAt: nowIso() });
      return async () => {
        await fsp.rm(lockDir(), { recursive: true, force: true });
      };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (await removeLockIfStale()) continue;
      if (Date.now() >= deadline) return null;
      await sleep(200);
    }
  }
}

async function defaultExecutePrompt(job, onStatus) {
  return runPrompt({
    requestId: job.id,
    prompt: job.prompt,
    model: job.model || '',
    effort: job.effort || '',
    conversation: job.conversation || '',
    host: job.host || CONFIG.host,
    port: Number.isFinite(job.port) ? job.port : CONFIG.port,
    connectTimeoutMs: Number.isFinite(job.connectTimeoutMs) ? job.connectTimeoutMs : CONFIG.connectTimeoutMs,
    responseTimeoutMs: Number.isFinite(job.responseTimeoutMs) ? job.responseTimeoutMs : CONFIG.responseTimeoutMs,
    token: CONFIG.token,
    debug: !!job.debug,
    onStatus,
  });
}

async function runOneJob(job, executePrompt) {
  const startedAt = nowIso();
  await updateJob(job.id, (current) => ({
    status: 'running',
    statusStage: current.status === 'running' ? (current.statusStage || 'reattaching') : 'starting',
    startedAt: current.startedAt || startedAt,
    runnerPid: process.pid,
    attempts: (current.attempts || 0) + 1,
    error: undefined,
  }));

  let statusUpdate = Promise.resolve();
  const onStatus = (stage) => {
    if (!stage) return;
    statusUpdate = statusUpdate
      .then(() => updateJob(job.id, { status: 'running', statusStage: stage, runnerPid: process.pid }))
      .catch(() => {}); // best-effort progress only
  };

  try {
    const latest = await readJob(job.id);
    const result = await executePrompt(latest || job, onStatus);
    await statusUpdate;
    if (!result || !result.conversation || !result.userMessageId) {
      throw new Error('ChatGPT did not return an accepted conversation/message identity');
    }
    await updateJob(job.id, {
      status: 'submitted',
      statusStage: 'generating',
      conversation: result.conversation,
      userMessageId: result.userMessageId,
      submittedAt: nowIso(),
      runnerPid: undefined,
    });
  } catch (err) {
    await statusUpdate;
    await updateJob(job.id, {
      status: 'error',
      statusStage: 'error',
      error: errorMessage(err),
      resultConversation: err && err.conversation || '',
      conversation: err && err.conversation || job.conversation || '',
      finishedAt: nowIso(),
      runnerPid: undefined,
    });
  }
}

async function defaultFetchConversation(job) {
  return dumpConversation({
    conversation: job.conversation,
    host: job.host || CONFIG.host,
    port: Number.isFinite(job.port) ? job.port : CONFIG.port,
    connectTimeoutMs: Number.isFinite(job.connectTimeoutMs) ? job.connectTimeoutMs : CONFIG.connectTimeoutMs,
    responseTimeoutMs: Number.isFinite(job.responseTimeoutMs) ? job.responseTimeoutMs : CONFIG.responseTimeoutMs,
    token: CONFIG.token,
  });
}

/** Poll one submitted job through ChatGPT's conversation endpoint. */
export async function refreshJob(id, { fetchConversation = defaultFetchConversation } = {}) {
  const job = await readJob(id);
  if (!job) throw new Error(`job not found: ${id}`);
  if (TERMINAL.has(job.status) || job.status !== 'submitted') return job;
  if (!job.conversation || !job.userMessageId) {
    throw new Error(`submitted job ${id} is missing its conversation/message identity`);
  }

  const fetched = await fetchConversation(job);
  const data = fetched && fetched.data ? fetched.data : fetched;
  const state = inspectSubmission(data, {
    conversation: (fetched && fetched.conversation) || job.conversation,
    prompt: job.prompt,
    userMessageId: job.userMessageId,
  });
  const checkedAt = nowIso();

  if (state.state === 'done') {
    return updateJob(id, {
      status: 'done',
      statusStage: 'done',
      text: state.text,
      resultConversation: state.conversation || job.conversation,
      assistantMessageId: state.assistantMessageId || '',
      messageStatus: state.messageStatus || '',
      checkedAt,
      finishedAt: checkedAt,
    });
  }
  if (state.state === 'error') {
    return updateJob(id, {
      status: 'error',
      statusStage: 'error',
      error: state.error || 'ChatGPT generation failed',
      resultConversation: state.conversation || job.conversation,
      assistantMessageId: state.assistantMessageId || '',
      messageStatus: state.messageStatus || '',
      checkedAt,
      finishedAt: checkedAt,
    });
  }
  return updateJob(id, {
    status: 'submitted',
    statusStage: 'generating',
    assistantMessageId: state.assistantMessageId || '',
    messageStatus: state.messageStatus || '',
    checkedAt,
  });
}

export async function runQueue({
  executePrompt = defaultExecutePrompt,
  idleGraceMs = DEFAULT_IDLE_GRACE_MS,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
} = {}) {
  const release = await acquireRunnerLock({ waitMs: lockWaitMs });
  if (!release) return { locked: true, processed: 0 };

  let processed = 0;
  try {
    for (;;) {
      let job = await nextRunnableJob();
      if (!job) {
        await sleep(idleGraceMs);
        job = await nextRunnableJob();
        if (!job) break;
      }
      await runOneJob(job, executePrompt);
      processed++;
    }
    return { locked: false, processed };
  } finally {
    await release();
  }
}

export function startQueueRunner() {
  const binPath = fileURLToPath(new URL('../bin/prolink.js', import.meta.url));
  const child = spawn(process.execPath, [binPath, '--run-queue'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}

export async function waitForJob(id, { pollMs = 1000, timeoutMs = 0, onUpdate = () => {} } = {}) {
  let lastUpdatedAt = '';
  const started = Date.now();
  for (;;) {
    const job = await readJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (job.updatedAt !== lastUpdatedAt) {
      lastUpdatedAt = job.updatedAt || '';
      onUpdate(job);
    }
    if (TERMINAL.has(job.status)) return job;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0 && Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for job ${id} to finish; it is still ${job.status}${job.statusStage ? ` (${job.statusStage})` : ''}. Use --status ${id} or --wait ${id} to check it later.`);
    }
    await sleep(pollMs);
  }
}

export async function waitForSubmission(id, { pollMs = 250, timeoutMs = 0, onUpdate = () => {} } = {}) {
  let lastUpdatedAt = '';
  const started = Date.now();
  for (;;) {
    const job = await readJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (job.updatedAt !== lastUpdatedAt) {
      lastUpdatedAt = job.updatedAt || '';
      onUpdate(job);
    }
    if (SUBMISSION_SETTLED.has(job.status)) return job;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0 && Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for job ${id} to submit; it is still ${job.status}${job.statusStage ? ` (${job.statusStage})` : ''}. Use --status ${id} to check it later.`);
    }
    await sleep(pollMs);
  }
}
