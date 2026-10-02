const ROUTE_START = 'HATCH_HTTP_ROUTE_SPECS=[';
const ROUTE_END = '],PATH_PARAM_REGEX';

export function extractGatewayRoutes(source) {
  const start = source.indexOf(ROUTE_START);
  const end = source.indexOf(ROUTE_END, start);
  if (start < 0 || end < 0) {
    return [];
  }

  const block = source.slice(start + ROUTE_START.length, end);
  const pattern = /\{method:`([^`]+)`,httpMethod:`([^`]+)`,path:`([^`]+)`([^}]*)\}/g;
  return [...block.matchAll(pattern)].map((match) => ({
    method: match[1],
    httpMethod: match[2],
    path: match[3],
    service: /service:`([^`]+)`/.exec(match[4])?.[1] ?? 'gateway',
    transport: /noiseOnly:!0/.test(match[4]) ? 'noise_required' : 'gateway',
    stream: /streamMode:`([^`]+)`/.exec(match[4])?.[1] ?? null,
  }));
}

export function extractBrowserCommands(source) {
  const start = source.indexOf('const COMMAND_SCHEMA = {');
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < 0) {
    return [];
  }

  const block = source.slice(start, end);
  return [...block.matchAll(/^  '([^']+)': \{/gm)].map((match) => match[1]);
}

export function groupRoutes(routes) {
  const groups = {};
  for (const route of routes) {
    const group = route.method.split('.')[0];
    groups[group] ??= [];
    groups[group].push(route.method);
  }
  return groups;
}