import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { executeBridgeRequest, runStdioBridge } from '../src/bridge/stdio.mjs';

test('executeBridgeRequest maps versioned operations to CLI arguments', async () => {
  const calls = [];
  const response = await executeBridgeRequest(
    { id: 'one', op: 'protocol.routes', params: { prefix: 'chat.' } },
    {
      executeCli: async (args) => {
        calls.push(args);
        return { exitCode: 0, output: JSON.stringify({ ok: true, routes: [] }) };
      },
    },
  );

  assert.deepEqual(calls, [['protocol', 'routes', 'chat.', '--json']]);
  assert.deepEqual(response, {
    version: 1,
    id: 'one',
    ok: true,
    result: { ok: true, routes: [] },
  });
});

test('executeBridgeRequest rejects unsupported operations', async () => {
  const response = await executeBridgeRequest({ id: 2, op: 'unknown.operation' });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unsupported_operation');
});

test('bridge describes its discoverable operation surface', async () => {
  const response = await executeBridgeRequest({ version: 1, id: 'describe', op: 'bridge.describe' });

  assert.equal(response.ok, true);
  assert.equal(response.result.protocol, 'ndjson');
  assert.equal(response.result.operations.some(({ op }) => op === 'protocol.routes'), true);
  assert.equal(response.result.operations.some(({ op }) => op === 'chat.send'), true);
  assert.equal(response.result.operations.some(({ op }) => op === 'delegate.batch'), true);
});

test('bridge passes message content through injected stdin instead of argv', async () => {
  const calls = [];
  const response = await executeBridgeRequest(
    { id: 'send', op: 'chat.send', params: { message: 'private prompt text' } },
    {
      executeCli: async (args, dependencies) => {
        calls.push({ args, input: await dependencies.readInput() });
        return { exitCode: 0, output: JSON.stringify({ ok: true, accepted: true }) };
      },
    },
  );

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{ args: ['chat', 'send', '--json'], input: 'private prompt text' }]);
  assert.equal(JSON.stringify(calls[0].args).includes('private prompt text'), false);
});

test('bridge rejects missing message parameters before invoking the CLI', async () => {
  const executeCli = async () => assert.fail('invalid message requests must not reach the CLI');
  const send = await executeBridgeRequest({ id: 'send', op: 'chat.send', params: {} }, { executeCli });
  const batch = await executeBridgeRequest({ id: 'batch', op: 'delegate.batch', params: {} }, { executeCli });

  assert.equal(send.error.code, 'invalid_params');
  assert.equal(batch.error.code, 'invalid_params');
});

test('bridge rejects unsupported protocol versions', async () => {
  const response = await executeBridgeRequest({ version: 99, id: 'future', op: 'doctor' });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unsupported_version');
});

test('stdio bridge returns one response for each non-empty input line', async () => {
  const input = Readable.from(['not-json\n', '{"id":3,"op":"doctor"}\n']);
  let outputText = '';
  const output = new Writable({
    write(chunk, encoding, callback) {
      outputText += chunk.toString();
      callback();
    },
  });

  await runStdioBridge({
    input,
    output,
    executeRequest: async (request) => ({ version: 1, id: request.id, ok: true, result: {} }),
  });

  const responses = outputText.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].error.code, 'invalid_json');
  assert.equal(responses[1].id, 3);
});