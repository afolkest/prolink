import assert from 'node:assert/strict';
import {
  formatLastAssistantJson,
  formatLastAssistantText,
  formatTranscriptJson,
  formatTranscriptMarkdown,
  inspectSubmission,
  lastAssistantTurn,
  normalizeConversation,
} from '../src/transcript.js';

const fixture = {
  title: 'Branching fixture',
  current_node: 'assistant-current',
  mapping: {
    root: { id: 'root', parent: null, children: ['system'], message: null },
    system: {
      id: 'system', parent: 'root', children: ['user-1'],
      message: { id: 'system-msg', author: { role: 'system' }, create_time: 1, content: { parts: ['hidden'] } },
    },
    'user-1': {
      id: 'user-1', parent: 'system', children: ['assistant-old', 'assistant-current'],
      message: { id: 'user-msg', author: { role: 'user' }, create_time: 2, content: { parts: ['Hello'] } },
    },
    'assistant-old': {
      id: 'assistant-old', parent: 'user-1', children: [],
      message: { id: 'old-msg', author: { role: 'assistant' }, create_time: 3, content: { parts: ['Abandoned branch'] } },
    },
    'assistant-current': {
      id: 'assistant-current', parent: 'user-1', children: [],
      message: { id: 'assistant-msg', author: { role: 'assistant' }, create_time: 4, content: { parts: ['Hi there', { text: 'How can I help?' }] } },
    },
    hidden: {
      id: 'hidden', parent: 'assistant-current', children: [],
      message: {
        id: 'hidden-msg', author: { role: 'assistant' }, create_time: 5,
        metadata: { is_visually_hidden_from_conversation: true },
        content: { parts: ['do not export'] },
      },
    },
  },
};

const transcript = normalizeConversation(fixture, { conversation: 'conv-123' });
assert.equal(transcript.conversation, 'conv-123');
assert.equal(transcript.title, 'Branching fixture');
assert.deepEqual(transcript.turns.map((t) => [t.role, t.text]), [
  ['user', 'Hello'],
  ['assistant', 'Hi there\nHow can I help?'],
]);

const { current_node: _currentNode, ...branchingWithoutCurrent } = fixture;
assert.throws(
  () => normalizeConversation(branchingWithoutCurrent, { conversation: 'conv-branchy' }),
  /no usable current_node; refusing to guess the current branch/,
  'branching conversations without current_node must not export abandoned branches',
);
assert.throws(
  () => normalizeConversation({ ...fixture, current_node: 'missing-node' }, { conversation: 'conv-bad-current' }),
  /current_node is not present in mapping/,
  'unrecognized current_node should be treated as endpoint-shape drift',
);

const linearWithoutCurrent = normalizeConversation({
  title: 'Linear fallback fixture',
  mapping: {
    root: { id: 'root', parent: null, children: ['user'], message: null },
    user: {
      id: 'user', parent: 'root', children: ['assistant'],
      message: { id: 'linear-user-msg', author: { role: 'user' }, create_time: 1, content: { parts: ['Linear question'] } },
    },
    assistant: {
      id: 'assistant', parent: 'user', children: [],
      message: { id: 'linear-assistant-msg', author: { role: 'assistant' }, create_time: 2, content: { parts: ['Linear answer'] } },
    },
  },
}, { conversation: 'conv-linear' });
assert.deepEqual(linearWithoutCurrent.turns.map((t) => [t.role, t.text]), [
  ['user', 'Linear question'],
  ['assistant', 'Linear answer'],
]);

const markdown = formatTranscriptMarkdown(transcript, { exportedAt: '2026-06-28T00:00:00.000Z' });
assert.match(markdown, /^# ChatGPT conversation transcript/);
assert.match(markdown, /Conversation: conv-123/);
assert.match(markdown, /## 1\. User\n\nHello/);
assert.match(markdown, /## 2\. Assistant\n\nHi there\nHow can I help\?/);
assert.doesNotMatch(markdown, /Abandoned branch|do not export/);
assert.match(
  formatTranscriptMarkdown({ turns: [{ role: 'assistant', text: 'a\n\n\nb' }] }, { exportedAt: '2026-06-28T00:00:00.000Z' }),
  /a\n\n\nb/,
  'markdown formatter should not collapse message-internal blank lines',
);

const json = JSON.parse(formatTranscriptJson(transcript, { exportedAt: '2026-06-28T00:00:00.000Z' }));
assert.equal(json.exportedAt, '2026-06-28T00:00:00.000Z');
assert.equal(json.turns.length, 2);

assert.deepEqual(lastAssistantTurn(transcript), {
  id: 'assistant-msg',
  role: 'assistant',
  text: 'Hi there\nHow can I help?',
  createTime: 4,
});
assert.equal(formatLastAssistantText(transcript), 'Hi there\nHow can I help?\n');
const lastJson = JSON.parse(formatLastAssistantJson(transcript, { exportedAt: '2026-06-28T00:00:00.000Z' }));
assert.equal(lastJson.exportedAt, '2026-06-28T00:00:00.000Z');
assert.equal(lastJson.conversation, 'conv-123');
assert.deepEqual(lastJson.turn, lastAssistantTurn(transcript));
assert.throws(
  () => lastAssistantTurn({ turns: [{ role: 'user', text: 'no answer yet' }] }),
  /no assistant response/,
);

// Regression: a completed answer from an older turn must not satisfy the job
// for a newly submitted user message whose assistant response is still pending.
const pendingSubmission = {
  conversation_id: 'conv-two-turns',
  current_node: 'user-new',
  mapping: {
    root: { id: 'root', parent: null, children: ['user-old'], message: null },
    'user-old': {
      id: 'user-old', parent: 'root', children: ['assistant-old'],
      message: { id: 'user-old-msg', author: { role: 'user' }, content: { parts: ['LIC question'] } },
    },
    'assistant-old': {
      id: 'assistant-old', parent: 'user-old', children: ['user-new'],
      message: {
        id: 'assistant-old-msg', author: { role: 'assistant' }, status: 'finished_successfully', end_turn: true,
        content: { parts: ['Old LIC answer'] },
      },
    },
    'user-new': {
      id: 'user-new', parent: 'assistant-old', children: [],
      message: { id: 'user-new-msg', author: { role: 'user' }, content: { parts: ['Cubature prompt'] } },
    },
  },
};
const pending = inspectSubmission(pendingSubmission, {
  prompt: 'Cubature prompt',
  userMessageId: 'user-new-msg',
});
assert.equal(pending.state, 'pending');
assert.equal(pending.text, '');
assert.notEqual(pending.text, 'Old LIC answer');

const streamingSubmission = structuredClone(pendingSubmission);
streamingSubmission.mapping['user-new'].children = ['assistant-new'];
streamingSubmission.mapping['assistant-new'] = {
  id: 'assistant-new', parent: 'user-new', children: [],
  message: {
    id: 'assistant-new-msg', author: { role: 'assistant' }, status: 'in_progress', end_turn: false,
    content: { parts: ['Partial cubature answer'] },
  },
};
streamingSubmission.current_node = 'assistant-new';
const streaming = inspectSubmission(streamingSubmission, {
  prompt: 'Cubature prompt',
  userMessageId: 'user-new-msg',
});
assert.equal(streaming.state, 'pending');
assert.equal(streaming.text, 'Partial cubature answer');

const completedSubmission = structuredClone(streamingSubmission);
completedSubmission.mapping['assistant-new'].message.status = 'finished_successfully';
completedSubmission.mapping['assistant-new'].message.end_turn = true;
completedSubmission.mapping['assistant-new'].message.content.parts = ['Correct cubature answer'];
const completed = inspectSubmission(completedSubmission, {
  prompt: 'Cubature prompt',
  userMessageId: 'user-new-msg',
});
assert.equal(completed.state, 'done');
assert.equal(completed.text, 'Correct cubature answer');
assert.equal(completed.conversation, 'conv-two-turns');

console.log('  ok   transcript normalization + formatting');
