import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPromptJob,
  listJobs,
  readJob,
  refreshJob,
  runQueue,
  updateJob,
  waitForJob,
  waitForSubmission,
} from '../src/jobs.js';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'prolink-jobs-test-'));
process.env.PROLINK_STATE_DIR = tmp;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const privateMode = (mode) => (mode & 0o077) === 0;

try {
  const first = await createPromptJob({ prompt: 'first prompt', model: '5.6 Sol', effort: 'Medium', responseTimeoutMs: 1234 });
  const second = await createPromptJob({ prompt: 'second prompt', model: '5.6 Sol', effort: 'High' });

  assert.equal(first.status, 'queued');
  assert.equal(first.responseTimeoutMs, 1234);
  assert.equal(first.model, '5.6 Sol');
  assert.equal(first.effort, 'Medium');
  assert.match(first.id, /^job-/);
  assert.equal(privateMode((await stat(tmp)).mode), true, 'state dir should not be group/world-readable');
  assert.equal(privateMode((await stat(path.join(tmp, 'jobs'))).mode), true, 'jobs dir should not be group/world-readable');
  assert.equal(privateMode((await stat(path.join(tmp, 'jobs', `${first.id}.json`))).mode), true, 'job files should not be group/world-readable');

  const calls = [];
  const result = await runQueue({
    idleGraceMs: 5,
    lockWaitMs: 0,
    executePrompt: async (job, onStatus) => {
      calls.push({ id: job.id, model: job.model, effort: job.effort });
      await onStatus(`fake running ${job.prompt}`);
      return { conversation: `conv-${job.id}`, userMessageId: `user-${job.id}` };
    },
  });

  assert.equal(result.locked, false);
  assert.equal(result.processed, 2);
  assert.deepEqual(calls, [
    { id: first.id, model: '5.6 Sol', effort: 'Medium' },
    { id: second.id, model: '5.6 Sol', effort: 'High' },
  ], 'jobs should preserve model/effort and run FIFO');

  const submitted = await readJob(first.id);
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.statusStage, 'generating');
  assert.equal(submitted.conversation, `conv-${first.id}`);
  assert.equal(submitted.userMessageId, `user-${first.id}`);
  assert.equal(submitted.attempts, 1);

  const accepted = await waitForSubmission(second.id, { pollMs: 1 });
  assert.equal(accepted.status, 'submitted');

  const pending = await refreshJob(first.id, {
    fetchConversation: async (job) => ({
      conversation: job.conversation,
      data: {
        current_node: 'user',
        mapping: {
          user: {
            id: 'user', parent: null, children: [],
            message: { id: job.userMessageId, author: { role: 'user' }, content: { parts: [job.prompt] } },
          },
        },
      },
    }),
  });
  assert.equal(pending.status, 'submitted', 'a submitted job remains pending until its own assistant message finishes');

  const done = await refreshJob(first.id, {
    fetchConversation: async (job) => ({
      conversation: job.conversation,
      data: {
        current_node: 'assistant',
        mapping: {
          user: {
            id: 'user', parent: null, children: ['assistant'],
            message: { id: job.userMessageId, author: { role: 'user' }, content: { parts: [job.prompt] } },
          },
          assistant: {
            id: 'assistant', parent: 'user', children: [],
            message: {
              id: 'assistant-new', author: { role: 'assistant' }, status: 'finished_successfully', end_turn: true,
              content: { parts: [`reply to ${job.prompt}`] },
            },
          },
        },
      },
    }),
  });
  assert.equal(done.status, 'done');
  assert.equal(done.text, 'reply to first prompt');

  const queued = await createPromptJob({ prompt: 'older queued' });
  const stale = await createPromptJob({ prompt: 'newer stale running' });
  await updateJob(stale.id, { status: 'running', statusStage: 'extension connected', runnerPid: -1 });

  const recoveryCalls = [];
  await runQueue({
    idleGraceMs: 5,
    lockWaitMs: 0,
    executePrompt: async (job) => {
      recoveryCalls.push(job.id);
      return { conversation: `conv-${job.id}`, userMessageId: `user-${job.id}` };
    },
  });
  assert.deepEqual(recoveryCalls, [stale.id, queued.id], 'stale running jobs should resume before queued jobs');

  const contended = await createPromptJob({ prompt: 'lock contention' });
  let releaseGate;
  let started = false;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const firstRunner = runQueue({
    idleGraceMs: 5,
    lockWaitMs: 0,
    executePrompt: async (job) => {
      assert.equal(job.id, contended.id);
      started = true;
      await gate;
      return { conversation: 'conv-lock', userMessageId: 'user-lock' };
    },
  });
  const startDeadline = Date.now() + 1000;
  while (!started && Date.now() < startDeadline) await sleep(1);
  assert.equal(started, true, 'first runner should start before lock contention check');
  const secondRunner = await runQueue({
    idleGraceMs: 5,
    lockWaitMs: 0,
    executePrompt: async () => { throw new Error('second runner should not execute while lock is held'); },
  });
  assert.equal(secondRunner.locked, true, 'second runner should not process while another runner holds the lock');
  releaseGate();
  assert.equal((await firstRunner).processed, 1);

  const neverFinishes = await createPromptJob({ prompt: 'never finishes' });
  await assert.rejects(
    waitForJob(neverFinishes.id, { pollMs: 1, timeoutMs: 5 }),
    /Timed out waiting for job/,
    'waitForJob should support bounded foreground waits'
  );

  const listed = await listJobs();
  assert.deepEqual(listed.map((job) => job.id).sort(), [first.id, second.id, queued.id, stale.id, contended.id, neverFinishes.id].sort());

  console.log('  ok   file-backed prompt submission jobs');
} finally {
  delete process.env.PROLINK_STATE_DIR;
  await rm(tmp, { recursive: true, force: true });
}
