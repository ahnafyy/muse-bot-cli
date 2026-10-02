#!/usr/bin/env node

import { runStdioBridge } from '../bridge/stdio.mjs';
import { runInAppBridgeServer } from '../bridge/in-app.mjs';
import { runCli } from '../cli/run.mjs';

const args = process.argv.slice(2);
const commandArgs = args.filter((arg) => arg !== '--json');

if (commandArgs.length === 3 && commandArgs[0] === 'bridge' && commandArgs[1] === 'in-app' && commandArgs[2] === 'serve') {
	process.exitCode = await runInAppBridgeServer();
} else if (commandArgs.length === 2 && commandArgs[0] === 'bridge' && commandArgs[1] === 'stdio') {
	process.exitCode = await runStdioBridge();
} else {
	const result = await runCli(args);
	const destination = result.exitCode === 0 ? process.stdout : process.stderr;

	destination.write(`${result.output}\n`);
	process.exitCode = result.exitCode;
}