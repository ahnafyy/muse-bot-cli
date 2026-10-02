import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForMuseResponse } from '../src/platform/macos/muse-actions.mjs';

const staticText = (value) => ({ role: 'AXStaticText', value, children: [] });
const button = (title) => ({ role: 'AXButton', title, children: [] });
const group = (...children) => ({ role: 'AXGroup', children });

function snapshot(messages, running) {
  const children = messages.flatMap((message) => message.role === 'user'
    ? [group(staticText('You:'), group(staticText(message.content)))]
    : [group(group(staticText(message.content)), group(button('Reply')), group(button('Copy response')))]);
  return {
    role: 'AXWindow',
    children: [
      { role: 'AXGroup', title: 'Chat messages', children },
      button(`Message Attach file Dictate a message ${running ? 'Stop' : 'Send'}`),
    ],
  };
}

test('waitForMuseResponse ignores assistant progress while Muse is running', async () => {
  const snapshots = [
    snapshot([{ role: 'user', content: 'Research Hawaii' }], true),
    snapshot([
      { role: 'user', content: 'Research Hawaii' },
      { role: 'assistant', content: 'Browser Starting' },
    ], true),
    snapshot([
      { role: 'user', content: 'Research Hawaii' },
      { role: 'assistant', content: 'Final itinerary' },
    ], false),
  ];
  let index = 0;
  const result = await waitForMuseResponse({
    helper: async () => ({ ok: true, snapshot: snapshots[Math.min(index++, snapshots.length - 1)] }),
    timeoutMs: 100,
    intervalMs: 1,
  });

  assert.equal(result.completed, true);
  assert.equal(result.response.content, 'Final itinerary');
  assert.equal(index, 3);
});