import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildInAppBootstrap,
  callInAppBridge,
  getInAppBridgeStatus,
  startInAppBridge,
} from '../src/bridge/in-app.mjs';

test('in-app bridge brokers an authenticated allowlisted Muse request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbot-in-app-'));
  const statePath = join(directory, 'state.json');
  const bridge = await startInAppBridge({ statePath, requestTimeoutMs: 1_000 });
  const baseUrl = `http://${bridge.state.host}:${bridge.state.port}`;
  const headers = { authorization: `Bearer ${bridge.state.key}`, 'content-type': 'application/json' };

  try {
    await fetch(`${baseUrl}/v1/hello`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ documentTitle: 'Muse', path: '/chat', rpcReady: true }),
    });

    const page = (async () => {
      const request = await fetch(`${baseUrl}/v1/next`, { headers }).then((response) => response.json());
      assert.equal(request.method, 'shared_agents.list');
      await fetch(`${baseUrl}/v1/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: request.id, ok: true, result: { agents: [{ name: 'Test Agent' }] } }),
      });
    })();

    const response = await callInAppBridge('shared_agents.list', {}, { statePath });
    await page;
    assert.deepEqual(response.result, { agents: [{ name: 'Test Agent' }] });

    const status = await getInAppBridgeStatus({ statePath });
    assert.equal(status.page.documentTitle, 'Muse');
    assert.equal(status.page.rpcReady, true);
  } finally {
    await bridge.close();
  }
});

test('in-app bridge rejects methods outside the read allowlist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbot-in-app-'));
  const statePath = join(directory, 'state.json');
  const bridge = await startInAppBridge({ statePath, requestTimeoutMs: 100 });

  try {
    await assert.rejects(
      callInAppBridge('shared_agents.delete', {}, { statePath }),
      (error) => error.code === 'unsupported_operation',
    );
  } finally {
    await bridge.close();
  }
});

test('bootstrap contains no Muse credentials and targets the local broker', async () => {
  const script = buildInAppBootstrap({ host: '127.0.0.1', port: 43210, key: 'local-bridge-key' });

  assert.match(script, /127\.0\.0\.1:43210/);
  assert.match(script, /shared_agents|sendRequest|v1\/next/);
  assert.doesNotMatch(script, /vmAuthToken|noiseNotaryToken|requestVmToken/);
});