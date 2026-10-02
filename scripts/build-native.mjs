import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(root, '.build');
const output = join(outputDirectory, 'mbot-helper');

mkdirSync(outputDirectory, { recursive: true });
execFileSync('xcrun', [
  'swiftc',
  join(root, 'native', 'MBotHelper', 'main.swift'),
  '-o', output,
  '-framework', 'AppKit',
  '-framework', 'ApplicationServices',
], { stdio: 'inherit' });

console.log(output);