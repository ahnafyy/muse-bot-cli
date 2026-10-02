import { execFile as execFileCallback } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function execFile(file, args, { input, maxBuffer } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFileCallback(file, args, { maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export function defaultHelperPath() {
  return resolve(projectRoot, '.build', 'mbot-helper');
}

export async function runAccessibilityHelper(command, args = [], {
  helperPath = defaultHelperPath(),
  execute = execFile,
  input,
} = {}) {
  try {
    await access(helperPath);
  } catch {
    const error = new Error('Native helper is not built. Run: npm run build:native');
    error.code = 'native_helper_missing';
    throw error;
  }

  try {
    const { stdout } = await execute(helperPath, [command, ...args], { input, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim().length > 0) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}