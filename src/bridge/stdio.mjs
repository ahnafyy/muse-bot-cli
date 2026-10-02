import { once } from 'node:events';
import { createInterface } from 'node:readline';

import { runCli } from '../cli/run.mjs';

export const BRIDGE_VERSION = 1;

const OPERATIONS = Object.freeze({
  doctor: () => ['doctor', '--json'],
  capabilities: () => ['capabilities', '--json'],
  'auth.status': () => ['auth', 'status', '--json'],
  'protocol.routes': (params) => [
    'protocol',
    'routes',
    ...(typeof params.prefix === 'string' && params.prefix.length > 0 ? [params.prefix] : []),
    '--json',
  ],
  'browser.commands': () => ['browser', 'commands', '--json'],
  'agents.list': () => ['agents', 'list', '--json'],
  'chat.current': (params) => ['chat', 'current', String(params.limit ?? 20), '--json'],
  'chat.status': () => ['chat', 'status', '--json'],
  'chat.send': () => ['chat', 'send', '--json'],
  'chat.ask': (params) => ['chat', 'ask', String(params.timeout_seconds ?? 120), '--json'],
  'delegate.run': (params) => ['delegate', 'run', String(params.timeout_seconds ?? 120), '--json'],
  'delegate.batch': (params) => ['delegate', 'batch', String(params.timeout_seconds ?? 120), '--json'],
});

const BRIDGE_DESCRIPTION = Object.freeze({
  protocol: 'ndjson',
  version: BRIDGE_VERSION,
  operations: [
    { op: 'bridge.describe', params: {} },
    { op: 'doctor', params: {} },
    { op: 'capabilities', params: {} },
    { op: 'auth.status', params: {} },
    { op: 'protocol.routes', params: { prefix: 'optional string' } },
    { op: 'browser.commands', params: {} },
    { op: 'agents.list', params: {} },
    { op: 'chat.current', params: { limit: 'optional integer from 1 to 100' } },
    { op: 'chat.status', params: {} },
    { op: 'chat.send', params: { message: 'required string' } },
    { op: 'chat.ask', params: { message: 'required string', timeout_seconds: 'optional integer' } },
    { op: 'delegate.run', params: { message: 'required string', timeout_seconds: 'optional integer' } },
    { op: 'delegate.batch', params: { messages: 'required string array', timeout_seconds: 'optional integer' } },
  ],
});

function bridgeError(code, message) {
  return { code, message };
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return bridgeError('invalid_request', 'Request must be a JSON object.');
  }
  if (!['string', 'number'].includes(typeof request.id)) {
    return bridgeError('invalid_request', 'Request id must be a string or number.');
  }
  if (request.version !== undefined && request.version !== BRIDGE_VERSION) {
    return bridgeError('unsupported_version', `Unsupported bridge version: ${request.version}`);
  }
  if (typeof request.op !== 'string' || request.op.length === 0) {
    return bridgeError('invalid_request', 'Request op must be a non-empty string.');
  }
  if (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))) {
    return bridgeError('invalid_request', 'Request params must be an object when provided.');
  }
  return null;
}

export async function executeBridgeRequest(request, { executeCli = runCli } = {}) {
  const validationError = validateRequest(request);
  if (validationError) {
    return { version: BRIDGE_VERSION, id: request?.id ?? null, ok: false, error: validationError };
  }

  if (request.op === 'bridge.describe') {
    return { version: BRIDGE_VERSION, id: request.id, ok: true, result: BRIDGE_DESCRIPTION };
  }

  const buildArgs = OPERATIONS[request.op];
  if (!buildArgs) {
    return {
      version: BRIDGE_VERSION,
      id: request.id,
      ok: false,
      error: bridgeError('unsupported_operation', `Unsupported bridge operation: ${request.op}`),
    };
  }

  const params = request.params ?? {};
  const usesMessage = ['chat.send', 'chat.ask', 'delegate.run'].includes(request.op);
  const usesMessages = request.op === 'delegate.batch';
  if (usesMessage && (typeof params.message !== 'string' || params.message.trim().length === 0)) {
    return {
      version: BRIDGE_VERSION,
      id: request.id,
      ok: false,
      error: bridgeError('invalid_params', 'A non-empty message is required.'),
    };
  }
  if (usesMessages && (!Array.isArray(params.messages) || params.messages.length === 0)) {
    return {
      version: BRIDGE_VERSION,
      id: request.id,
      ok: false,
      error: bridgeError('invalid_params', 'A non-empty messages array is required.'),
    };
  }
  const input = usesMessage ? params.message : usesMessages ? JSON.stringify(params.messages) : undefined;
  const result = await executeCli(
    buildArgs(params),
    input === undefined ? undefined : { readInput: async () => input },
  );
  let payload;
  try {
    payload = JSON.parse(result.output);
  } catch {
    return {
      version: BRIDGE_VERSION,
      id: request.id,
      ok: false,
      error: bridgeError('invalid_cli_response', 'CLI operation did not return JSON.'),
    };
  }

  if (result.exitCode !== 0 || payload.ok === false) {
    return {
      version: BRIDGE_VERSION,
      id: request.id,
      ok: false,
      error: payload.error ?? bridgeError('operation_failed', 'Bridge operation failed.'),
    };
  }

  return { version: BRIDGE_VERSION, id: request.id, ok: true, result: payload };
}

async function writeLine(output, value) {
  if (!output.write(`${JSON.stringify(value)}\n`)) {
    await once(output, 'drain');
  }
}

export async function runStdioBridge({
  input = process.stdin,
  output = process.stdout,
  executeRequest = executeBridgeRequest,
} = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });

  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      await writeLine(output, {
        version: BRIDGE_VERSION,
        id: null,
        ok: false,
        error: bridgeError('invalid_json', 'Input line is not valid JSON.'),
      });
      continue;
    }

    try {
      await writeLine(output, await executeRequest(request));
    } catch {
      await writeLine(output, {
        version: BRIDGE_VERSION,
        id: request?.id ?? null,
        ok: false,
        error: bridgeError('internal_error', 'Unexpected bridge failure.'),
      });
    }
  }

  return 0;
}