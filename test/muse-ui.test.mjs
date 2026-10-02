import assert from 'node:assert/strict';
import test from 'node:test';

import { currentMuseUi } from '../src/platform/macos/muse-ui.mjs';

const staticText = (value) => ({ role: 'AXStaticText', value, children: [] });
const button = (title) => ({ role: 'AXButton', title, children: [] });
const group = (...children) => ({ role: 'AXGroup', children });

test('currentMuseUi extracts the current agent and structured messages', () => {
  const snapshot = group(
    group(
      group(
        staticText('Assistant message: Welcome'),
        group(staticText('You:'), group(staticText('Hello'))),
        group(group(staticText('Hi '), group(staticText('there'))), group(button('Reply')), group(button('Copy response'))),
      ),
    ),
    group(button('Message Attach file Dictate a message Send'), button('Rawool'), button('Rawool')),
  );

  assert.deepEqual(currentMuseUi(snapshot), {
    agent: 'Rawool',
    agents: [{ name: 'Rawool', current: true, status: null }],
    messages: [
      { role: 'assistant', content: 'Welcome' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ],
    status: 'completed',
  });
});

test('currentMuseUi extracts the connected agent from the expanded activity panel', () => {
  const snapshot = group(
    group(staticText('Rawool'), staticText('Connected')),
    button('Message Attach file Dictate a message Send'),
  );

  assert.deepEqual(currentMuseUi(snapshot).agents, [
    { name: 'Rawool', current: true, status: 'connected' },
  ]);
  assert.equal(currentMuseUi(snapshot).agent, 'Rawool');
});

test('currentMuseUi parses a side chat from its direct message groups', () => {
  const snapshot = {
    role: 'AXWindow',
    children: [{
      role: 'AXGroup',
      title: 'Chat messages',
      children: [
        group(staticText('10:03 PM')),
        group(staticText('You:'), group(staticText('Run the probe'))),
        group(button('More options')),
        group(button('Copy response')),
        group(button('Reply')),
        group(group(group(staticText('Probe complete'), group(button('Reply')), group(button('Copy response'))))),
      ],
    }],
  };

  assert.deepEqual(currentMuseUi(snapshot).messages, [
    { role: 'user', content: 'Run the probe' },
    { role: 'assistant', content: 'Probe complete' },
  ]);
  assert.equal(currentMuseUi(snapshot).status, 'completed');
});

test('currentMuseUi reports a running response from the Stop composer control', () => {
  const snapshot = group(
    group(staticText('You:'), group(staticText('Research Hawaii'))),
    button('Message Attach file Dictate a message Stop'),
  );

  assert.equal(currentMuseUi(snapshot).status, 'running');
});