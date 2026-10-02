import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../src/cli/run.mjs';

const discovery = {
  installed: true,
  running: true,
  appPath: '/Applications/Muse.app',
  metadata: { bundleId: 'com.meta.endo', version: '4.1', build: '1077426479', releaseChannel: 'production' },
  session: {
    status: 'store_present_unverified',
    stores: { http: true, webkit: true, browserNodeId: true },
  },
  browser: { available: true, extensionVersion: '1.0.8', commands: ['tabs.list', 'page.snapshot'], dispatch: 'unverified' },
  gateway: {
    catalogAvailable: true,
    transport: 'noise_attested',
    routes: [
      { method: 'chat.history', httpMethod: 'GET', path: '/chat/history', transport: 'gateway' },
      { method: 'chat.subscribe', httpMethod: 'POST', path: '/chat/subscribe', transport: 'noise_required' },
    ],
  },
  compatibility: { status: 'capture_required', fingerprint: 'fixture-fingerprint', hashes: {} },
};

const dependencies = { discover: async () => discovery };

test('help presents mbot as the public executable', async () => {
  const result = await runCli(['help'], dependencies);

  assert.match(result.output, /^mbot 0\.1\.0/);
  assert.match(result.output, /Usage: mbot <command>/);
});

test('in-app bridge commands avoid Muse discovery and map session read operations', async () => {
  const calls = [];
  const bridgeDependencies = {
    discover: async () => assert.fail('bridge commands should not run discovery'),
    callBridge: async (method, params) => {
      calls.push({ method, params });
      return { ok: true, result: { items: [] } };
    },
  };

  const sessions = await runCli(['sessions', 'list', '--json'], bridgeDependencies);
  const history = await runCli(['chat', 'history', 'session-1', '12', '--json'], bridgeDependencies);

  assert.equal(sessions.exitCode, 0);
  assert.equal(history.exitCode, 0);
  assert.deepEqual(calls, [
    { method: 'sessions.list', params: {} },
    { method: 'chat.history', params: { session_id: 'session-1', limit: 12 } },
  ]);
});

test('ui commands map to the native Accessibility helper', async () => {
  const calls = [];
  const uiDependencies = {
    discover: async () => assert.fail('ui commands should not run discovery'),
    accessibilityHelper: async (command, args = []) => {
      calls.push({ command, args });
      return command === 'snapshot'
        ? { ok: true, trusted: true, snapshot: { role: 'AXApplication' } }
        : { ok: true, trusted: command === 'request-permission', app: { pid: 123 } };
    },
  };

  const status = await runCli(['ui', 'status'], uiDependencies);
  const permission = await runCli(['ui', 'request-permission'], uiDependencies);
  const snapshot = await runCli(['ui', 'snapshot', '10', '500', '--json'], uiDependencies);

  assert.match(status.output, /not granted/);
  assert.match(permission.output, /granted/);
  assert.equal(JSON.parse(snapshot.output).snapshot.role, 'AXApplication');
  assert.deepEqual(calls, [
    { command: 'status', args: [] },
    { command: 'request-permission', args: [] },
    { command: 'snapshot', args: ['10', '500'] },
  ]);
});

test('current agent and chat commands parse the visible Muse snapshot', async () => {
  const snapshot = {
    role: 'AXWindow',
    children: [{
      role: 'AXGroup',
      children: [
        { role: 'AXStaticText', value: 'Assistant message: Hello', children: [] },
        { role: 'AXButton', title: 'Message Attach file Dictate a message Send', children: [] },
        { role: 'AXButton', title: 'Rawool', children: [] },
        { role: 'AXButton', title: 'Rawool', children: [] },
      ],
    }],
  };
  const uiDependencies = {
    discover: async () => assert.fail('current UI commands should not run discovery'),
    accessibilityHelper: async () => ({ ok: true, trusted: true, snapshot }),
    writeAgents: async () => {},
  };

  const agent = await runCli(['agent', 'current'], uiDependencies);
  const agents = await runCli(['agents', 'list', '--json'], uiDependencies);
  const chat = await runCli(['chat', 'current', '5', '--json'], uiDependencies);
  const chatStatus = await runCli(['chat', 'status', '--json'], uiDependencies);

  assert.equal(agent.output, 'Rawool');
  assert.deepEqual(JSON.parse(agents.output), {
    ok: true,
    source: 'accessibility',
    agents: [{ name: 'Rawool', current: true, status: null }],
  });
  assert.equal(JSON.parse(chat.output).agent, 'Rawool');
  assert.deepEqual(JSON.parse(chat.output).messages, [{ role: 'assistant', content: 'Hello' }]);
  assert.equal(JSON.parse(chatStatus.output).status, 'completed');
});

test('agents list falls back to the last live observation in side chats', async () => {
  const result = await runCli(['agents', 'list', '--json'], {
    accessibilityHelper: async () => ({ ok: true, trusted: true, snapshot: { role: 'AXWindow', children: [] } }),
    readAgents: async () => [{ name: 'Rawool', current: true, status: null }],
  });

  assert.deepEqual(JSON.parse(result.output), {
    ok: true,
    source: 'cache',
    agents: [{ name: 'Rawool', current: true, status: null }],
  });
});

test('chat and delegation commands use verified message actions', async () => {
  const calls = [];
  const actionDependencies = {
    readInput: async () => 'Find a Hawaii trip under $100',
    accessibilityHelper: async () => assert.fail('action dependency should own helper calls'),
    openSideChat: async () => calls.push('open'),
    sendMessage: async (message) => {
      calls.push(['send', message]);
      return { ok: true, accepted: true, agent: 'Rawool' };
    },
    waitForResponse: async ({ timeoutMs }) => {
      calls.push(['wait', timeoutMs]);
      return { ok: true, completed: true, agent: 'Rawool', response: { role: 'assistant', content: 'Done' } };
    },
  };

  const send = await runCli(['chat', 'send', '--json'], actionDependencies);
  const ask = await runCli(['chat', 'ask', '30', '--json'], actionDependencies);
  const delegate = await runCli(['delegate', 'run', '45', '--json'], actionDependencies);

  assert.equal(JSON.parse(send.output).accepted, true);
  assert.equal(JSON.parse(ask.output).response.content, 'Done');
  assert.equal(JSON.parse(delegate.output).delegated, true);
  assert.deepEqual(calls, [
    ['send', 'Find a Hawaii trip under $100'],
    ['send', 'Find a Hawaii trip under $100'],
    ['wait', 30_000],
    'open',
    ['send', 'Find a Hawaii trip under $100'],
    ['wait', 45_000],
  ]);
});

test('batch delegation reports each side-chat result', async () => {
  const prompts = ['budget 100', 'budget 200'];
  let chatCount = 0;
  const result = await runCli(['delegate', 'batch', '20', '--json'], {
    readInput: async () => JSON.stringify(prompts),
    openSideChat: async () => { chatCount += 1; },
    sendMessage: async (message) => ({ ok: true, accepted: true, message }),
    waitForResponse: async () => ({
      ok: true,
      completed: true,
      response: { role: 'assistant', content: `result ${chatCount}` },
    }),
  });

  const output = JSON.parse(result.output);
  assert.equal(result.exitCode, 0);
  assert.equal(chatCount, 2);
  assert.deepEqual(output.jobs.map((job) => job.response.content), ['result 1', 'result 2']);
});

test('doctor emits structured JSON without session contents', async () => {
  const result = await runCli(['doctor', '--json'], dependencies);
  const output = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(output.metadata.bundleId, 'com.meta.endo');
  assert.equal(output.session.status, 'store_present_unverified');
  assert.equal(JSON.stringify(output).includes('cookie'), false);
});

test('capabilities report native messaging without claiming browser dispatch', async () => {
  const result = await runCli(['capabilities', '--json'], dependencies);
  const output = JSON.parse(result.output);

  assert.equal(output.capabilities.messaging.status, 'available_accessibility');
  assert.equal(output.capabilities.tasks.status, 'available_side_chats');
  assert.equal(output.capabilities.interoperability.protocol, 'ndjson-v1');
  assert.equal(output.capabilities.browser.status, 'schema_available_dispatch_unverified');
  assert.deepEqual(output.capabilities.browser.commands, ['tabs.list', 'page.snapshot']);
  assert.deepEqual(output.gateway.groups, [{ name: 'chat', count: 2 }]);
});

test('auth status distinguishes store presence from verified authentication', async () => {
  const result = await runCli(['auth', 'status', '--json'], dependencies);
  const output = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.equal(output.status, 'muse_session_present_unverified');
  assert.equal(output.ready, false);
  assert.match(output.note, /not enabled/);
});

test('unknown commands return the usage exit code', async () => {
  const result = await runCli(['nope'], dependencies);

  assert.equal(result.exitCode, 2);
  assert.match(result.output, /Unknown command/);
});

test('protocol routes can be filtered by method prefix', async () => {
  const result = await runCli(['protocol', 'routes', 'chat.sub', '--json'], dependencies);
  const output = JSON.parse(result.output);

  assert.deepEqual(output.routes.map((route) => route.method), ['chat.subscribe']);
});

test('browser commands report the installed schema catalog', async () => {
  const result = await runCli(['browser', 'commands', '--json'], dependencies);
  const output = JSON.parse(result.output);

  assert.deepEqual(output.commands, ['tabs.list', 'page.snapshot']);
});