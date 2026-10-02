import { setTimeout as delay } from 'node:timers/promises';

import { currentMuseUi } from './muse-ui.mjs';
import { runAccessibilityHelper } from './accessibility.mjs';

const SNAPSHOT_ARGS = ['20', '10000'];

function failed(data, fallback) {
  if (data?.ok) {
    return null;
  }
  const error = new Error(data?.error?.message ?? fallback);
  error.code = data?.error?.code ?? 'muse_action_failed';
  return error;
}

async function snapshot(helper) {
  const data = await helper('snapshot', SNAPSHOT_ARGS);
  const error = failed(data, 'Muse snapshot failed.');
  if (error) throw error;
  return currentMuseUi(data.snapshot);
}

function findLabel(node, suffix) {
  if (!node) return null;
  for (const value of [node.title, node.description]) {
    if (typeof value === 'string' && value.endsWith(suffix)) return value;
  }
  for (const child of node.children ?? []) {
    const match = findLabel(child, suffix);
    if (match) return match;
  }
  return null;
}

export async function sendCurrentMuseMessage(message, {
  helper = runAccessibilityHelper,
  attempts = 12,
  intervalMs = 250,
} = {}) {
  const text = message.trim();
  if (!text) throw Object.assign(new Error('Message must not be empty.'), { code: 'missing_input' });

  const before = await snapshot(helper);
  const submitted = await helper('submit', [], { input: text });
  const submitError = failed(submitted, 'Muse message submission failed.');
  if (submitError) throw submitError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await snapshot(helper);
    const userIndex = current.messages.findLastIndex((item) => item.role === 'user' && item.content.trim() === text);
    if (userIndex >= 0 && current.messages.length > before.messages.length) {
      return { ok: true, accepted: true, agent: current.agent, message: current.messages[userIndex] };
    }
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  throw Object.assign(new Error('Muse did not show the submitted message before verification timed out.'), {
    code: 'message_not_confirmed',
  });
}

export async function waitForMuseResponse({
  helper = runAccessibilityHelper,
  timeoutMs = 120_000,
  intervalMs = 1_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = await snapshot(helper);
  const userIndex = latest.messages.findLastIndex((item) => item.role === 'user');
  if (userIndex < 0) {
    throw Object.assign(new Error('No visible user message is available to wait on.'), { code: 'user_message_not_found' });
  }

  while (true) {
    const response = latest.messages.slice(userIndex + 1).findLast((item) => item.role === 'assistant');
    if (response && latest.status !== 'running') {
      return { ok: true, completed: true, agent: latest.agent, response };
    }
    if (Date.now() >= deadline) {
      return { ok: true, completed: false, agent: latest.agent, response: null };
    }
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    latest = await snapshot(helper);
  }
}

export async function openNewMuseSideChat({ helper = runAccessibilityHelper } = {}) {
  let data = await helper('snapshot', SNAPSHOT_ARGS);
  let error = failed(data, 'Muse snapshot failed.');
  if (error) throw error;

  const serialized = JSON.stringify(data.snapshot);
  if (!serialized.includes('New side chat')) {
    const chatsLabel = findLabel(data.snapshot, 'Open chat and side chats');
    if (!chatsLabel) {
      throw Object.assign(new Error('Muse Chats control was not found.'), { code: 'chats_control_not_found' });
    }
    data = await helper('press', [chatsLabel]);
    error = failed(data, 'Muse chat panel could not be opened.');
    if (error) throw error;
  }
  data = await helper('press', ['New side chat']);
  error = failed(data, 'Muse could not create a side chat.');
  if (error) throw error;
  return { ok: true, created: true };
}