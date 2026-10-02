import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

function modulesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? modulesUnder(path) : extname(entry.name) === '.mjs' ? [path] : [];
  });
}

for (const file of [...modulesUnder('src'), ...modulesUnder('test')]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}