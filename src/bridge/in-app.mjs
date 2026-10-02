import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const IN_APP_BRIDGE_VERSION = 1;
export const IN_APP_READ_METHODS = Object.freeze([
  'shared_agents.list',
  'shared_agents.detail',
  'sessions.list',
  'sessions.get',
  'chat.history',
  'chat.message_get',
  'tasks.list',
  'tasks.runs',
  'activity.list',
  'activity.get',
  'artifacts.list',
]);

const READ_METHODS = new Set(IN_APP_READ_METHODS);
const MAX_BODY_BYTES = 1024 * 1024;

export function defaultInAppBridgeStatePath(homeDir = homedir()) {
  return join(homeDir, '.mbot', 'in-app-bridge.json');
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  return typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null;
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function readInAppBridgeState(path = defaultInAppBridgeStatePath()) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function publicPageStatus(page) {
  if (!page) {
    return null;
  }
  return {
    connectedAt: page.connectedAt,
    documentTitle: page.documentTitle ?? null,
    path: page.path ?? null,
    rpcReady: page.rpcReady === true,
  };
}

export async function startInAppBridge({
  host = '127.0.0.1',
  port = 0,
  statePath = defaultInAppBridgeStatePath(),
  requestTimeoutMs = 30_000,
} = {}) {
  const key = randomBytes(32).toString('base64url');
  const pendingPagePolls = [];
  const queuedRequests = [];
  const pendingCalls = new Map();
  let page = null;

  function deliverNext() {
    while (pendingPagePolls.length > 0 && queuedRequests.length > 0) {
      const response = pendingPagePolls.shift();
      clearTimeout(response.pollTimeout);
      sendJson(response, 200, queuedRequests.shift());
    }
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-origin': '*',
        });
        response.end();
        return;
      }

      if (bearerToken(request) !== key) {
        sendJson(response, 401, { ok: false, error: { code: 'unauthorized', message: 'Invalid bridge key.' } });
        return;
      }

      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'POST' && url.pathname === '/v1/hello') {
        const body = await readJsonBody(request);
        page = {
          connectedAt: new Date().toISOString(),
          documentTitle: typeof body.documentTitle === 'string' ? body.documentTitle : null,
          path: typeof body.path === 'string' ? body.path : null,
          rpcReady: body.rpcReady === true,
        };
        sendJson(response, 200, { ok: true, version: IN_APP_BRIDGE_VERSION, methods: IN_APP_READ_METHODS });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/next') {
        if (queuedRequests.length > 0) {
          sendJson(response, 200, queuedRequests.shift());
          return;
        }
        response.pollTimeout = setTimeout(() => {
          const index = pendingPagePolls.indexOf(response);
          if (index >= 0) {
            pendingPagePolls.splice(index, 1);
          }
          response.writeHead(204, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
          response.end();
        }, 20_000);
        pendingPagePolls.push(response);
        request.on('close', () => {
          const index = pendingPagePolls.indexOf(response);
          if (index >= 0) {
            pendingPagePolls.splice(index, 1);
            clearTimeout(response.pollTimeout);
          }
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/result') {
        const body = await readJsonBody(request);
        const pending = pendingCalls.get(body.id);
        if (!pending) {
          sendJson(response, 404, { ok: false, error: { code: 'unknown_request', message: 'Unknown request id.' } });
          return;
        }
        pendingCalls.delete(body.id);
        clearTimeout(pending.timeout);
        pending.resolve(body);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/status') {
        sendJson(response, 200, {
          ok: true,
          version: IN_APP_BRIDGE_VERSION,
          page: publicPageStatus(page),
          methods: IN_APP_READ_METHODS,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/call') {
        const body = await readJsonBody(request);
        if (!READ_METHODS.has(body.method)) {
          sendJson(response, 400, {
            ok: false,
            error: { code: 'unsupported_operation', message: `Bridge method is not allowlisted: ${body.method}` },
          });
          return;
        }
        if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
          sendJson(response, 400, {
            ok: false,
            error: { code: 'invalid_request', message: 'Bridge params must be an object.' },
          });
          return;
        }

        const id = randomUUID();
        const result = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            pendingCalls.delete(id);
            resolve({
              id,
              ok: false,
              error: { code: 'bridge_timeout', message: 'Muse did not answer the bridge request in time.' },
            });
          }, requestTimeoutMs);
          pendingCalls.set(id, { resolve, timeout });
          queuedRequests.push({ version: IN_APP_BRIDGE_VERSION, id, method: body.method, params: body.params });
          deliverNext();
        });
        sendJson(response, result.ok ? 200 : 502, result);
        return;
      }

      sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown bridge endpoint.' } });
    } catch {
      sendJson(response, 400, { ok: false, error: { code: 'invalid_request', message: 'Invalid bridge request.' } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const state = {
    version: IN_APP_BRIDGE_VERSION,
    pid: process.pid,
    host,
    port: address.port,
    key,
    startedAt: new Date().toISOString(),
  };
  await writeState(statePath, state);

  return {
    state,
    statePath,
    async close() {
      for (const response of pendingPagePolls.splice(0)) {
        clearTimeout(response.pollTimeout);
        response.destroy();
      }
      for (const [id, pending] of pendingCalls) {
        clearTimeout(pending.timeout);
        pending.resolve({ id, ok: false, error: { code: 'bridge_closed', message: 'Bridge closed.' } });
      }
      pendingCalls.clear();
      await new Promise((resolve) => server.close(resolve));
      await rm(statePath, { force: true });
    },
  };
}

async function bridgeFetch(path, { statePath, method = 'GET', body } = {}) {
  const state = await readInAppBridgeState(statePath);
  const response = await fetch(`http://${state.host}:${state.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${state.key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message ?? 'In-app bridge request failed.');
    error.code = result.error?.code ?? 'bridge_error';
    throw error;
  }
  return result;
}

export function callInAppBridge(method, params = {}, options = {}) {
  return bridgeFetch('/v1/call', { ...options, method: 'POST', body: { method, params } });
}

export function getInAppBridgeStatus(options = {}) {
  return bridgeFetch('/v1/status', options);
}

export function buildInAppBootstrap(state) {
  const origin = `http://${state.host}:${state.port}`;
  const configuration = JSON.stringify({ origin, key: state.key, version: IN_APP_BRIDGE_VERSION });
  return `(() => {
  const config = ${configuration};
  const headers = { authorization: 'Bearer ' + config.key, 'content-type': 'application/json' };
  const findRpc = () => {
    const seen = new Set();
    const stack = [];
    for (const element of document.querySelectorAll('*')) {
      for (const key of Object.keys(element)) {
        if (key.startsWith('__reactFiber$')) stack.push(element[key]);
        if (key.startsWith('__reactContainer$')) stack.push(element[key]?.current ?? element[key]);
      }
    }
    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const value = fiber.memoizedProps?.value;
      if (value && typeof value.sendRequest === 'function' && typeof value.ensureLiveConnection === 'function') {
        return value;
      }
      stack.push(fiber.return, fiber.child, fiber.sibling);
    }
    return null;
  };
  const controller = new AbortController();
  const post = (path, body) => fetch(config.origin + path, {
    method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', signal: controller.signal
  });
  const run = async () => {
    let rpc = findRpc();
    await post('/v1/hello', {
      documentTitle: document.title,
      path: location.pathname + location.search + location.hash,
      rpcReady: rpc?.isReady === true
    });
    for (;;) {
      const response = await fetch(config.origin + '/v1/next', { headers, cache: 'no-store', signal: controller.signal });
      if (response.status === 204) continue;
      const request = await response.json();
      try {
        rpc = findRpc();
        if (!rpc) throw new Error('Muse RPC context was not found.');
        if (!rpc.isReady) await rpc.ensureLiveConnection();
        const result = await rpc.sendRequest(request.method, request.params);
        await post('/v1/result', { id: request.id, ok: true, result });
      } catch (error) {
        await post('/v1/result', {
          id: request.id,
          ok: false,
          error: { code: 'muse_request_failed', message: error instanceof Error ? error.message : String(error) }
        });
      }
    }
  };
  if (window.__MBOT_IN_APP_BRIDGE__?.stop) window.__MBOT_IN_APP_BRIDGE__.stop();
  window.__MBOT_IN_APP_BRIDGE__ = { version: config.version, stop: () => controller.abort() };
  run().catch(error => { if (error?.name !== 'AbortError') console.error('[mbot bridge]', error); });
  console.info('[mbot bridge] bootstrap installed');
})();`;
}

export async function runInAppBridgeServer({ output = process.stdout, ...options } = {}) {
  const bridge = await startInAppBridge(options);
  output.write(`mbot in-app bridge listening on http://${bridge.state.host}:${bridge.state.port}\n`);
  output.write(`Run "mbot bridge in-app bootstrap" in another terminal and evaluate it in Muse's Web Inspector.\n`);

  const stop = Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM')]);
  await stop;
  await bridge.close();
  return 0;
}