function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function contentPartToText(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (typeof part.name === 'string' && typeof part.url === 'string') return `[${part.name}](${part.url})`;
  if (typeof part.asset_pointer === 'string') return `[attachment: ${part.asset_pointer}]`;
  if (typeof part.content_type === 'string') return `[${part.content_type}]`;
  try { return JSON.stringify(part); } catch { return '[unprintable content part]'; }
}

export function messageText(message) {
  const content = message.content;
  if (typeof content === 'string') return cleanText(content);
  const obj = asObject(content);
  if (Array.isArray(obj.parts)) return cleanText(obj.parts.map(contentPartToText).filter(Boolean).join('\n'));
  if (typeof obj.text === 'string') return cleanText(obj.text);
  if (typeof obj.result === 'string') return cleanText(obj.result);
  return '';
}

function branchForConversation(data) {
  const doc = asObject(data);
  const mapping = asObject(doc.mapping);
  const currentNode = doc.current_node || doc.currentNode || '';
  let ids;
  if (currentNode) {
    if (!mapping[currentNode]) {
      throw new Error('ChatGPT conversation JSON current_node is not present in mapping; refusing to guess the current branch.');
    }
    ids = currentBranchNodeIds(mapping, currentNode);
  } else {
    const leaf = uniqueLeafNodeId(mapping);
    ids = leaf ? currentBranchNodeIds(mapping, leaf) : [];
  }
  return { doc, mapping, currentNode, ids };
}

function nodeMessage(node) {
  const msg = asObject(asObject(node).message);
  return msg && Object.keys(msg).length ? msg : null;
}

function currentBranchNodeIds(mapping, currentNodeId) {
  const ids = [];
  const seen = new Set();
  let id = currentNodeId;
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    ids.push(id);
    id = mapping[id].parent;
  }
  return ids.reverse();
}

function uniqueLeafNodeId(mapping) {
  const entries = Object.entries(mapping);
  if (!entries.length) return '';
  const leaves = entries
    .filter(([, node]) => {
      const children = Array.isArray(asObject(node).children) ? node.children : [];
      return !children.some((childId) => mapping[childId]);
    })
    .map(([id]) => id);
  if (leaves.length === 1) return leaves[0];
  throw new Error('ChatGPT conversation JSON has no usable current_node; refusing to guess the current branch.');
}

/**
 * Convert ChatGPT's internal conversation JSON into the visible current-branch
 * transcript. The endpoint's `mapping` is a tree that can contain hidden system
 * nodes and abandoned branches; `current_node` identifies the branch the UI is
 * showing, which is what users expect a transcript dump to export.
 */
export function normalizeConversation(data, { conversation = '' } = {}) {
  const { doc, mapping, currentNode, ids } = branchForConversation(data);

  const turns = [];
  const seenMessages = new Set();
  for (const nodeId of ids) {
    const message = nodeMessage(mapping[nodeId]);
    if (!message || seenMessages.has(message.id || nodeId)) continue;
    seenMessages.add(message.id || nodeId);

    const role = asObject(message.author).role || '';
    if (role !== 'user' && role !== 'assistant') continue;
    if (asObject(message.metadata).is_visually_hidden_from_conversation) continue;

    const text = messageText(message);
    if (!text) continue;
    turns.push({
      id: message.id || nodeId,
      role,
      text,
      createTime: message.create_time || null,
    });
  }

  return {
    conversation: conversation || doc.conversation_id || doc.conversationId || '',
    title: doc.title || '',
    currentNode,
    turns,
  };
}

/**
 * Inspect the response belonging to one submitted user message.
 *
 * Unlike "last assistant text", this binds the result to the exact user
 * message returned by the browser at submit time. A completed answer from an
 * older turn can therefore never satisfy a newer job while its answer is still
 * generating.
 */
export function inspectSubmission(data, {
  conversation = '',
  prompt = '',
  userMessageId = '',
} = {}) {
  const { doc, mapping, ids } = branchForConversation(data);
  const branch = ids.map((nodeId) => ({ nodeId, message: nodeMessage(mapping[nodeId]) }));
  let userIndex = -1;

  if (userMessageId) {
    userIndex = branch.findIndex(({ nodeId, message }) =>
      nodeId === userMessageId || (message && message.id === userMessageId));
  } else {
    const expected = cleanText(prompt);
    for (let i = branch.length - 1; i >= 0; i--) {
      const message = branch[i].message;
      if (message && asObject(message.author).role === 'user' && messageText(message) === expected) {
        userIndex = i;
        break;
      }
    }
  }

  if (userIndex < 0) {
    throw new Error(`Submitted user message ${JSON.stringify(userMessageId || prompt)} is not on the conversation's current branch.`);
  }

  const user = branch[userIndex].message;
  if (!user || asObject(user.author).role !== 'user') {
    throw new Error('The recorded submitted message is not a user message.');
  }
  if (prompt && messageText(user) !== cleanText(prompt)) {
    throw new Error('The recorded submitted message text does not match this job prompt.');
  }

  let assistant = null;
  for (let i = userIndex + 1; i < branch.length; i++) {
    const message = branch[i].message;
    if (!message) continue;
    const role = asObject(message.author).role || '';
    if (role === 'user') break;
    if (role === 'assistant' && !asObject(message.metadata).is_visually_hidden_from_conversation) {
      assistant = message;
    }
  }

  const resultConversation = conversation || doc.conversation_id || doc.conversationId || '';
  const recordedUserMessageId = user.id || branch[userIndex].nodeId;
  if (!assistant) {
    return {
      state: 'pending',
      conversation: resultConversation,
      userMessageId: recordedUserMessageId,
      assistantMessageId: '',
      text: '',
      messageStatus: '',
    };
  }

  const status = String(assistant.status || '').toLowerCase();
  const text = messageText(assistant);
  const assistantMessageId = assistant.id || '';
  const failed = /error|failed|cancelled|canceled/.test(status);
  if (failed) {
    return {
      state: 'error',
      conversation: resultConversation,
      userMessageId: recordedUserMessageId,
      assistantMessageId,
      text,
      messageStatus: status,
      error: `ChatGPT assistant message ended with status ${JSON.stringify(status)}.`,
    };
  }

  // `finished_successfully` can also appear on intermediate reasoning/tool
  // messages. `end_turn: true` is the positive signal that this assistant node
  // finalized the response to the submitted user turn.
  const finished = assistant.end_turn === true && (!status || status === 'finished_successfully');
  return {
    state: finished && text ? 'done' : 'pending',
    conversation: resultConversation,
    userMessageId: recordedUserMessageId,
    assistantMessageId,
    text,
    messageStatus: status,
  };
}

export function formatTranscriptMarkdown(transcript, { exportedAt = new Date().toISOString() } = {}) {
  const lines = ['# ChatGPT conversation transcript', ''];
  if (transcript.title) lines.push(`Title: ${transcript.title}`);
  if (transcript.conversation) lines.push(`Conversation: ${transcript.conversation}`);
  lines.push(`Exported: ${exportedAt}`, '');

  transcript.turns.forEach((turn, index) => {
    const speaker = turn.role === 'assistant' ? 'Assistant' : 'User';
    lines.push(`## ${index + 1}. ${speaker}`, '');
    lines.push(turn.text.trim(), '');
  });

  return lines.join('\n').trimEnd() + '\n';
}

export function formatTranscriptJson(transcript, { exportedAt = new Date().toISOString() } = {}) {
  return JSON.stringify({ ...transcript, exportedAt }, null, 2) + '\n';
}

export function lastAssistantTurn(transcript) {
  const turns = Array.isArray(asObject(transcript).turns) ? transcript.turns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = asObject(turns[i]);
    if (turn.role === 'assistant' && cleanText(turn.text)) {
      return { ...turn, text: cleanText(turn.text) };
    }
  }
  throw new Error('Transcript has no assistant response on the current branch.');
}

export function formatLastAssistantText(transcript) {
  return lastAssistantTurn(transcript).text + '\n';
}

export function formatLastAssistantJson(transcript, { exportedAt = new Date().toISOString() } = {}) {
  return JSON.stringify({
    conversation: transcript.conversation || '',
    title: transcript.title || '',
    currentNode: transcript.currentNode || '',
    turn: lastAssistantTurn(transcript),
    exportedAt,
  }, null, 2) + '\n';
}
