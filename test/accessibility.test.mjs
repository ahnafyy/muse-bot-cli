import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runAccessibilityHelper } from '../src/platform/macos/accessibility.mjs';

test('runAccessibilityHelper passes stdin to native commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mbot-helper-test-'));
  const helperPath = join(directory, 'helper');
  await writeFile(helperPath, 'fixture');
  const calls = [];

  const result = await runAccessibilityHelper('submit', [], {
    helperPath,
    input: 'hello',
    execute: async (file, args, options) => {
      calls.push({ file, args, input: options.input });
      return { stdout: '{"ok":true}' };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ file: helperPath, args: ['submit'], input: 'hello' }]);
});