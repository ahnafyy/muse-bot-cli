import assert from 'node:assert/strict';
import test from 'node:test';

import { extractBrowserCommands, extractGatewayRoutes, groupRoutes } from '../src/protocol/catalog.mjs';

test('extractGatewayRoutes reads route metadata without evaluating app code', () => {
  const source = "before HATCH_HTTP_ROUTE_SPECS=[{method:`chat.history`,httpMethod:`GET`,path:`/chat/history`},{method:`chat.subscribe`,httpMethod:`POST`,path:`/chat/subscribe`,noiseOnly:!0,streamMode:`subscription`}],PATH_PARAM_REGEX after";
  const routes = extractGatewayRoutes(source);

  assert.deepEqual(routes, [
    { method: 'chat.history', httpMethod: 'GET', path: '/chat/history', service: 'gateway', transport: 'gateway', stream: null },
    { method: 'chat.subscribe', httpMethod: 'POST', path: '/chat/subscribe', service: 'gateway', transport: 'noise_required', stream: 'subscription' },
  ]);
  assert.deepEqual(groupRoutes(routes), { chat: ['chat.history', 'chat.subscribe'] });
});

test('extractBrowserCommands returns top-level command names', () => {
  const source = "const COMMAND_SCHEMA = {\n  'tabs.list': {\n    required: {},\n  },\n  'page.snapshot': {\n    optional: {},\n  },\n};\nfunction next() {}";

  assert.deepEqual(extractBrowserCommands(source), ['tabs.list', 'page.snapshot']);
});