import { CliError, EXIT_CODE } from '../core/errors.mjs';
import { errorResult, jsonResult } from '../core/output.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildInAppBootstrap,
  callInAppBridge,
  getInAppBridgeStatus,
  readInAppBridgeState,
} from '../bridge/in-app.mjs';
import { discoverMuse } from '../platform/macos/muse-discovery.mjs';
import { currentMuseUi } from '../platform/macos/muse-ui.mjs';
import { runAccessibilityHelper } from '../platform/macos/accessibility.mjs';
import {
  openNewMuseSideChat,
  sendCurrentMuseMessage,
  waitForMuseResponse,
} from '../platform/macos/muse-actions.mjs';
import { groupRoutes } from '../protocol/catalog.mjs';

export const VERSION = '0.1.0';

const HELP = `mbot ${VERSION}

Usage: mbot <command> [options]

Commands:
  doctor        Inspect the local Muse installation
  capabilities Show detected Muse capabilities
  protocol routes [prefix]
                List gateway methods detected in the installed Muse build
  browser commands
                List browser-node commands detected in the installed extension
  bridge stdio  Serve versioned NDJSON requests over stdin/stdout
  bridge in-app serve
                Start the authenticated Muse page broker
  bridge in-app bootstrap
                Print the script to evaluate in Muse's Web Inspector
  bridge in-app status
                Show whether the Muse page is attached
  agents list   List agents visible in the current Muse window
  sessions list List Muse chat sessions through the in-app bridge
  chat history <session-id> [limit]
                Read chat history through the in-app bridge
  ui status     Show native helper and Accessibility readiness
  ui request-permission
                Ask macOS to grant Accessibility access
  ui snapshot [max-depth] [max-nodes]
                Read a bounded Muse accessibility tree
  agent current Read the current agent name from the Muse window
  chat current [limit]
                Read recent visible messages from the Muse window
  chat status   Show whether the current chat is running or completed
  chat send     Send stdin to the current Muse chat and verify acceptance
  chat ask [timeout-seconds]
                Send stdin and wait for an assistant response
  chat wait [timeout-seconds]
                Wait for a response to the latest visible user message
  delegate run [timeout-seconds]
                Create a side chat, send stdin, and wait for its response
  delegate batch [timeout-seconds]
                Run a JSON array of prompts in separate side chats
  auth status   Show authentication readiness
  help          Show this help

Options:
  --json        Emit machine-readable JSON
  --version     Show the CLI version
  -h, --help    Show this help`;

function doctorText(report) {
  if (!report.installed) {
    return `Muse: not installed\nExpected: ${report.appPath}`;
  }

  return [
    `Muse: ${report.metadata.version} (${report.metadata.build})`,
    `Bundle: ${report.metadata.bundleId}`,
    `App: ${report.running ? 'running' : 'not running'}`,
    `Session: ${report.session.status}`,
    `Browser node: ${report.browser.extensionVersion} (${report.browser.dispatch} dispatch)`,
    `Compatibility: ${report.compatibility.status}`,
    `Fingerprint: ${report.compatibility.fingerprint}`,
  ].join('\n');
}

function capabilities(report) {
  const routeGroups = groupRoutes(report.gateway?.routes ?? []);
  return {
    ok: true,
    fingerprint: report.compatibility.fingerprint,
    capabilities: {
      diagnostics: { status: 'available', commands: ['doctor', 'auth.status', 'capabilities'] },
      interoperability: { status: 'available', commands: ['bridge.stdio'], protocol: 'ndjson-v1' },
      agents: { status: 'available_visible_ui', commands: ['agents.list', 'agent.current'] },
      messaging: { status: 'available_accessibility', commands: ['chat.current', 'chat.send', 'chat.ask', 'chat.wait'] },
      events: { status: 'available_polling', commands: ['chat.status', 'chat.wait'] },
      tasks: { status: 'available_side_chats', commands: ['delegate.run', 'delegate.batch'] },
      artifacts: { status: 'capture_required', commands: [] },
      browser: {
        status: report.browser.available ? 'schema_available_dispatch_unverified' : 'unavailable',
        extensionVersion: report.browser.extensionVersion ?? null,
        commands: report.browser.commands ?? [],
      },
    },
    gateway: {
      transport: report.gateway?.transport ?? 'unavailable',
      routeCount: report.gateway?.routes?.length ?? 0,
      groups: Object.entries(routeGroups).map(([name, methods]) => ({ name, count: methods.length })),
    },
  };
}

function capabilitiesText(data) {
  return Object.entries(data.capabilities)
    .map(([name, capability]) => `${name}: ${capability.status}`)
    .join('\n');
}

function authStatus(report) {
  const sessionPresent = report.installed && report.running && report.session.status === 'store_present_unverified';
  return {
    ok: true,
    ready: false,
    status: sessionPresent ? 'muse_session_present_unverified' : 'unavailable',
    source: sessionPresent ? 'installed_muse_app' : null,
    note: sessionPresent
      ? 'Muse session stores exist, but CLI authentication is not enabled until the control-plane adapter is captured.'
      : 'Open Muse and sign in before configuring CLI authentication.',
  };
}

function authText(data) {
  return [`Auth: ${data.status}`, `Ready: ${data.ready ? 'yes' : 'no'}`, data.note].join('\n');
}

function routeCatalog(report, prefix) {
  const routes = report.gateway?.routes ?? [];
  return prefix == null ? routes : routes.filter((route) => route.method.startsWith(prefix));
}

function routeCatalogText(routes) {
  if (routes.length === 0) {
    return 'No matching gateway routes detected.';
  }
  return routes
    .map((route) => `${route.method}\t${route.httpMethod}\t${route.path}\t${route.transport}`)
    .join('\n');
}

async function readStandardInput() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString('utf8');
}

function timeoutFrom(value) {
  const seconds = value === undefined ? 120 : Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new CliError('Timeout must be an integer from 1 to 3600 seconds.', {
      code: 'invalid_timeout',
      exitCode: EXIT_CODE.USAGE,
    });
  }
  return seconds * 1000;
}

function parsePromptBatch(input) {
  let prompts;
  try {
    prompts = JSON.parse(input);
  } catch {
    throw new CliError('Batch input must be a JSON array of prompt strings.', {
      code: 'invalid_batch',
      exitCode: EXIT_CODE.USAGE,
    });
  }
  if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > 50 ||
      prompts.some((prompt) => typeof prompt !== 'string' || prompt.trim().length === 0)) {
    throw new CliError('Batch input must contain 1 to 50 non-empty prompt strings.', {
      code: 'invalid_batch',
      exitCode: EXIT_CODE.USAGE,
    });
  }
  return prompts;
}

const agentCachePath = join(homedir(), '.mbot', 'agents.json');

async function readAgentCache() {
  try {
    const data = JSON.parse(await readFile(agentCachePath, 'utf8'));
    return Array.isArray(data.agents) ? data.agents : [];
  } catch {
    return [];
  }
}

async function writeAgentCache(agents) {
  await mkdir(dirname(agentCachePath), { recursive: true, mode: 0o700 });
  await writeFile(agentCachePath, `${JSON.stringify({ agents })}\n`, { mode: 0o600 });
}

export async function runCli(args, {
  discover = discoverMuse,
  callBridge = callInAppBridge,
  bridgeStatus = getInAppBridgeStatus,
  readBridgeState = readInAppBridgeState,
  buildBootstrap = buildInAppBootstrap,
  accessibilityHelper = runAccessibilityHelper,
  readInput = readStandardInput,
  sendMessage = sendCurrentMuseMessage,
  waitForResponse = waitForMuseResponse,
  openSideChat = openNewMuseSideChat,
  readAgents = readAgentCache,
  writeAgents = writeAgentCache,
} = {}) {
  const json = args.includes('--json');
  const commandArgs = args.filter((arg) => arg !== '--json');

  try {
    if (
      commandArgs.length === 0 ||
      commandArgs[0] === 'help' ||
      commandArgs.includes('-h') ||
      commandArgs.includes('--help')
    ) {
      return { exitCode: EXIT_CODE.SUCCESS, output: HELP };
    }

    if (commandArgs.length === 1 && commandArgs[0] === '--version') {
      return { exitCode: EXIT_CODE.SUCCESS, output: VERSION };
    }

    if (commandArgs[0] === 'ui') {
      if (commandArgs.length === 2 && commandArgs[1] === 'status') {
        const data = await accessibilityHelper('status');
        const output = [
          `Native helper: available`,
          `Accessibility: ${data.trusted ? 'granted' : 'not granted'}`,
          `Muse: ${data.app ? `running (${data.app.pid})` : 'not running'}`,
        ].join('\n');
        return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : output };
      }
      if (commandArgs.length === 2 && commandArgs[1] === 'request-permission') {
        const data = await accessibilityHelper('request-permission');
        const output = data.trusted
          ? 'Accessibility: granted'
          : 'Accessibility permission requested. Enable mbot-helper in System Settings > Privacy & Security > Accessibility.';
        return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : output };
      }
      if (commandArgs[1] === 'snapshot' && commandArgs.length >= 2 && commandArgs.length <= 4) {
        const numericArgs = commandArgs.slice(2).map(Number);
        if (numericArgs.some((value) => !Number.isSafeInteger(value) || value < 1)) {
          throw new CliError('Snapshot limits must be positive integers.', {
            code: 'invalid_snapshot_limit',
            exitCode: EXIT_CODE.USAGE,
          });
        }
        const data = await accessibilityHelper('snapshot', commandArgs.slice(2));
        if (!data.ok) {
          throw new CliError(data.error?.message ?? 'Muse snapshot failed.', {
            code: data.error?.code ?? 'snapshot_failed',
            exitCode: data.error?.code === 'accessibility_permission_required' ? EXIT_CODE.AUTH : EXIT_CODE.OPERATION,
          });
        }
        return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : JSON.stringify(data.snapshot, null, 2) };
      }
    }

    if (commandArgs.length === 2 && commandArgs[0] === 'agent' && commandArgs[1] === 'current') {
      const data = await accessibilityHelper('snapshot', ['20', '10000']);
      if (!data.ok) {
        throw new CliError(data.error?.message ?? 'Muse snapshot failed.', {
          code: data.error?.code ?? 'snapshot_failed',
          exitCode: data.error?.code === 'accessibility_permission_required' ? EXIT_CODE.AUTH : EXIT_CODE.OPERATION,
        });
      }
      const current = currentMuseUi(data.snapshot);
      if (!current.agent) {
        throw new CliError('Current Muse agent was not found in the visible window.', {
          code: 'agent_not_found',
          exitCode: EXIT_CODE.OPERATION,
        });
      }
      const result = { ok: true, agent: current.agent };
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(result) : current.agent };
    }

    if (commandArgs.length === 2 && commandArgs[0] === 'agents' && commandArgs[1] === 'list') {
      const data = await accessibilityHelper('snapshot', ['20', '10000']);
      if (!data.ok) {
        throw new CliError(data.error?.message ?? 'Muse snapshot failed.', {
          code: data.error?.code ?? 'snapshot_failed',
          exitCode: data.error?.code === 'accessibility_permission_required' ? EXIT_CODE.AUTH : EXIT_CODE.OPERATION,
        });
      }
      let agents = currentMuseUi(data.snapshot).agents;
      let source = 'accessibility';
      if (agents.length === 0) {
        agents = await readAgents();
        source = 'cache';
      } else {
        await writeAgents(agents);
      }
      if (agents.length === 0) {
        throw new CliError('No Muse agents were found in the visible window or last-seen cache.', {
          code: 'agents_not_found',
          exitCode: EXIT_CODE.OPERATION,
        });
      }
      const result = { ok: true, source, agents };
      const output = agents
        .map((agent) => [agent.name, agent.current ? 'current' : null, agent.status].filter(Boolean).join('\t'))
        .join('\n');
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(result) : output };
    }

    if (commandArgs[0] === 'chat' && commandArgs[1] === 'current' && commandArgs.length <= 3) {
      const limit = commandArgs[2] === undefined ? 20 : Number(commandArgs[2]);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError('Current chat limit must be an integer from 1 to 100.', {
          code: 'invalid_limit',
          exitCode: EXIT_CODE.USAGE,
        });
      }
      const data = await accessibilityHelper('snapshot', ['20', '10000']);
      if (!data.ok) {
        throw new CliError(data.error?.message ?? 'Muse snapshot failed.', {
          code: data.error?.code ?? 'snapshot_failed',
          exitCode: data.error?.code === 'accessibility_permission_required' ? EXIT_CODE.AUTH : EXIT_CODE.OPERATION,
        });
      }
      const current = currentMuseUi(data.snapshot);
      const messages = current.messages.slice(-limit);
      const result = { ok: true, agent: current.agent, messages };
      const output = messages.map((message) => `[${message.role}] ${message.content}`).join('\n\n');
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(result) : output };
    }

    if (commandArgs.length === 2 && commandArgs[0] === 'chat' && commandArgs[1] === 'status') {
      const data = await accessibilityHelper('snapshot', ['20', '10000']);
      if (!data.ok) {
        throw new CliError(data.error?.message ?? 'Muse snapshot failed.', {
          code: data.error?.code ?? 'snapshot_failed',
          exitCode: data.error?.code === 'accessibility_permission_required' ? EXIT_CODE.AUTH : EXIT_CODE.OPERATION,
        });
      }
      const current = currentMuseUi(data.snapshot);
      const result = { ok: true, agent: current.agent, status: current.status, messageCount: current.messages.length };
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(result) : `Chat: ${current.status}` };
    }

    if (commandArgs.length === 2 && commandArgs[0] === 'chat' && commandArgs[1] === 'send') {
      const result = await sendMessage(await readInput(), { helper: accessibilityHelper });
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(result) : 'Message accepted by Muse.' };
    }

    if (commandArgs[0] === 'chat' && commandArgs[1] === 'wait' && commandArgs.length <= 3) {
      const result = await waitForResponse({ helper: accessibilityHelper, timeoutMs: timeoutFrom(commandArgs[2]) });
      const output = result.completed ? result.response.content : 'No response before timeout.';
      return { exitCode: result.completed ? EXIT_CODE.SUCCESS : EXIT_CODE.OPERATION, output: json ? jsonResult(result) : output };
    }

    if (commandArgs[0] === 'chat' && commandArgs[1] === 'ask' && commandArgs.length <= 3) {
      const sent = await sendMessage(await readInput(), { helper: accessibilityHelper });
      const response = await waitForResponse({ helper: accessibilityHelper, timeoutMs: timeoutFrom(commandArgs[2]) });
      const result = { ok: response.completed, sent, ...response };
      const output = response.completed ? response.response.content : 'Message was accepted, but no response arrived before timeout.';
      return { exitCode: response.completed ? EXIT_CODE.SUCCESS : EXIT_CODE.OPERATION, output: json ? jsonResult(result) : output };
    }

    if (commandArgs[0] === 'delegate' && commandArgs[1] === 'run' && commandArgs.length <= 3) {
      await openSideChat({ helper: accessibilityHelper });
      const sent = await sendMessage(await readInput(), { helper: accessibilityHelper });
      const response = await waitForResponse({ helper: accessibilityHelper, timeoutMs: timeoutFrom(commandArgs[2]) });
      const result = { ok: response.completed, delegated: true, sent, ...response };
      const output = response.completed ? response.response.content : 'Delegation was accepted, but no response arrived before timeout.';
      return { exitCode: response.completed ? EXIT_CODE.SUCCESS : EXIT_CODE.OPERATION, output: json ? jsonResult(result) : output };
    }

    if (commandArgs[0] === 'delegate' && commandArgs[1] === 'batch' && commandArgs.length <= 3) {
      const timeoutMs = timeoutFrom(commandArgs[2]);
      const prompts = parsePromptBatch(await readInput());
      const jobs = [];
      for (const [index, prompt] of prompts.entries()) {
        try {
          await openSideChat({ helper: accessibilityHelper });
          const sent = await sendMessage(prompt, { helper: accessibilityHelper });
          const response = await waitForResponse({ helper: accessibilityHelper, timeoutMs });
          jobs.push({ index, ok: response.completed, prompt, sent, ...response });
        } catch (error) {
          jobs.push({ index, ok: false, prompt, error: { code: error.code ?? 'operation_failed', message: error.message } });
        }
      }
      const result = { ok: jobs.every((job) => job.ok), jobs };
      const output = jobs.map((job) => `${job.ok ? 'ok' : 'failed'}\t${job.index + 1}\t${job.response?.content ?? job.error?.message}`).join('\n');
      return { exitCode: result.ok ? EXIT_CODE.SUCCESS : EXIT_CODE.OPERATION, output: json ? jsonResult(result) : output };
    }

    if (commandArgs.length === 3 && commandArgs[0] === 'bridge' && commandArgs[1] === 'in-app') {
      if (commandArgs[2] === 'bootstrap') {
        const data = { ok: true, script: buildBootstrap(await readBridgeState()) };
        return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : data.script };
      }
      if (commandArgs[2] === 'status') {
        const data = await bridgeStatus();
        const output = data.page
          ? `Bridge: connected\nMuse page: ${data.page.documentTitle ?? 'untitled'}\nRPC ready: ${data.page.rpcReady ? 'yes' : 'no'}`
          : 'Bridge: waiting for Muse page bootstrap';
        return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : output };
      }
    }

    if (commandArgs.length === 2 && commandArgs[0] === 'sessions' && commandArgs[1] === 'list') {
      const data = await callBridge('sessions.list', {});
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : JSON.stringify(data.result, null, 2) };
    }

    if (commandArgs[0] === 'chat' && commandArgs[1] === 'history' && commandArgs.length >= 3 && commandArgs.length <= 4) {
      const limit = commandArgs[3] === undefined ? 32 : Number(commandArgs[3]);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CliError('Chat history limit must be an integer from 1 to 100.', {
          code: 'invalid_limit',
          exitCode: EXIT_CODE.USAGE,
        });
      }
      const data = await callBridge('chat.history', { session_id: commandArgs[2], limit });
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : JSON.stringify(data.result, null, 2) };
    }

    const report = await discover();
    if (commandArgs.length === 1 && commandArgs[0] === 'doctor') {
      const data = { ok: report.installed, ...report };
      return { exitCode: report.installed ? EXIT_CODE.SUCCESS : EXIT_CODE.OPERATION, output: json ? jsonResult(data) : doctorText(report) };
    }

    if (commandArgs.length === 1 && commandArgs[0] === 'capabilities') {
      const data = capabilities(report);
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : capabilitiesText(data) };
    }

    if (commandArgs[0] === 'protocol' && commandArgs[1] === 'routes' && commandArgs.length <= 3) {
      const routes = routeCatalog(report, commandArgs[2]);
      const data = { ok: true, fingerprint: report.compatibility.fingerprint, routes };
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : routeCatalogText(routes) };
    }

    if (commandArgs.length === 2 && commandArgs[0] === 'browser' && commandArgs[1] === 'commands') {
      const commands = report.browser.commands ?? [];
      const data = { ok: true, extensionVersion: report.browser.extensionVersion, commands };
      return { exitCode: EXIT_CODE.SUCCESS, output: json ? jsonResult(data) : commands.join('\n') };
    }

    if (commandArgs.length === 2 && commandArgs[0] === 'auth' && commandArgs[1] === 'status') {
      const data = authStatus(report);
      const exitCode = data.status === 'unavailable' ? EXIT_CODE.AUTH : EXIT_CODE.SUCCESS;
      return { exitCode, output: json ? jsonResult(data) : authText(data) };
    }

    throw new CliError(`Unknown command: ${commandArgs.join(' ')}`, {
      code: 'unknown_command',
      exitCode: EXIT_CODE.USAGE,
    });
  } catch (error) {
    const normalized = error instanceof CliError ? error : new CliError(error.message);
    return { exitCode: normalized.exitCode, output: errorResult(normalized, json) };
  }
}