import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(args, env = {}) {
  return spawnSync(process.execPath, ['bin/prolink.js', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

const help = run(['--help']);
assert.equal(help.status, 0);
assert.match(help.stdout, /prolink --dump <conversation-id>/);
assert.match(help.stdout, /--async\s+Enqueue and return immediately/);
assert.match(help.stdout, /--last\s+With --dump, print only the latest assistant response/);
assert.match(help.stdout, /--format <fmt>\s+Dump output format: md or json/);
assert.match(help.stdout, /--model <name>\s+Model label to select/);
assert.match(help.stdout, /--effort <name>\s+Reasoning-effort label to select/);

const missingEffort = run(['--effort']);
assert.equal(missingEffort.status, 2);
assert.match(missingEffort.stderr, /--effort requires a value/);

const jsonAlias = run(['--dump', 'conv-abc', '--json']);
assert.equal(jsonAlias.status, 2);
assert.match(jsonAlias.stderr, /--json is for prompt mode; use --format json with --dump/);

const promptArg = run(['--dump', 'conv-abc', 'extra prompt']);
assert.equal(promptArg.status, 2);
assert.match(promptArg.stderr, /--dump does not take a prompt argument/);

const lastWithoutDump = run(['--last', 'conv-abc']);
assert.equal(lastWithoutDump.status, 2);
assert.match(lastWithoutDump.stderr, /--last requires --dump <conversation-id>/);

const missingDump = run(['--dump', '--format', 'json']);
assert.equal(missingDump.status, 2);
assert.match(missingDump.stderr, /--dump requires a value/);

const missingDumpEqualsStyle = run(['--dump', '--format=json']);
assert.equal(missingDumpEqualsStyle.status, 2);
assert.match(missingDumpEqualsStyle.stderr, /--dump requires a value/);

const missingFormat = run(['--dump', 'conv-abc', '--format']);
assert.equal(missingFormat.status, 2);
assert.match(missingFormat.stderr, /--format requires a value/);

const missingOut = run(['--dump', 'conv-abc', '--out', '--format', 'json']);
assert.equal(missingOut.status, 2);
assert.match(missingOut.stderr, /--out requires a value/);

const badFormat = run(['--dump', 'conv-abc', '--format', 'xml']);
assert.equal(badFormat.status, 2);
assert.match(badFormat.stderr, /--format must be "md" or "json"/);

const state = await mkdtemp(path.join(os.tmpdir(), 'prolink-cli-jobs-'));
try {
  const jobsDir = path.join(state, 'jobs');
  await mkdir(jobsDir, { recursive: true });
  const job = {
    id: 'job-test1',
    kind: 'prompt',
    status: 'done',
    statusStage: 'done',
    prompt: 'fixture prompt',
    text: 'fixture reply',
    conversation: 'conv-fixture',
    model: '5.6 Sol',
    effort: 'Medium',
    attempts: 1,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:01.000Z',
    finishedAt: '2026-07-04T00:00:01.000Z',
  };
  await writeFile(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf8');
  const env = { PROLINK_STATE_DIR: state };

  const jobs = run(['--jobs'], env);
  assert.equal(jobs.status, 0);
  assert.match(jobs.stdout, /job-test1\tdone/);
  assert.match(jobs.stdout, /conv-fixture/);

  const status = run(['--status', 'job-test1'], env);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /status: done/);
  assert.match(status.stdout, /model: 5\.6 Sol/);
  assert.match(status.stdout, /effort: Medium/);
  assert.match(status.stdout, /conversation: conv-fixture/);

  const statusByConversation = run(['--status', 'conv-fixture'], env);
  assert.equal(statusByConversation.status, 0);
  assert.match(statusByConversation.stdout, /job: job-test1/);

  const result = run(['--result', 'job-test1'], env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'fixture reply\n');
  assert.match(result.stderr, /conversation: conv-fixture/);
} finally {
  await rm(state, { recursive: true, force: true });
}

console.log('  ok   dump/job CLI argument contract');
