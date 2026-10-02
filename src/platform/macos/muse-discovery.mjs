import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { extractBrowserCommands, extractGatewayRoutes } from '../../protocol/catalog.mjs';

const execFile = promisify(execFileCallback);

export function defaultMusePaths(homeDir = homedir(), appPath = '/Applications/Muse.app') {
  return {
    appPath,
    infoPlist: join(appPath, 'Contents', 'Info.plist'),
    executable: join(appPath, 'Contents', 'MacOS', 'Muse'),
    hatchBundle: join(appPath, 'Contents', 'Resources', 'hatch', 'index.html'),
    browserManifest: join(appPath, 'Contents', 'Resources', 'chrome', 'manifest.json'),
    browserProtocol: join(appPath, 'Contents', 'Resources', 'chrome', 'lib', 'protocol.js'),
    nodeId: join(homeDir, 'Library', 'Application Support', 'Hatch', 'node-id.txt'),
    httpStorage: join(homeDir, 'Library', 'HTTPStorages', 'com.meta.endo', 'httpstorages.sqlite'),
    webkitStorage: join(homeDir, 'Library', 'WebKit', 'com.meta.endo'),
  };
}

async function pathStatus(path) {
  try {
    const details = await stat(path);
    return { present: true, kind: details.isDirectory() ? 'directory' : 'file' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { present: false, kind: null };
    }
    throw error;
  }
}

async function plistValue(infoPlist, key) {
  const { stdout } = await execFile('plutil', ['-extract', key, 'raw', infoPlist]);
  return stdout.trim();
}

async function defaultMetadataReader(paths) {
  const [bundleId, version, build, releaseChannel] = await Promise.all([
    plistValue(paths.infoPlist, 'CFBundleIdentifier'),
    plistValue(paths.infoPlist, 'CFBundleShortVersionString'),
    plistValue(paths.infoPlist, 'CFBundleVersion'),
    plistValue(paths.infoPlist, 'HatchReleaseChannel'),
  ]);

  return { bundleId, version, build, releaseChannel };
}

async function defaultProcessChecker(executable) {
  try {
    const { stdout } = await execFile('pgrep', ['-f', executable]);
    return stdout.trim().length > 0;
  } catch (error) {
    if (error.code === 1) {
      return false;
    }
    throw error;
  }
}

async function hashFile(path) {
  await access(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function discoverMuse({
  paths = defaultMusePaths(),
  metadataReader = defaultMetadataReader,
  processChecker = defaultProcessChecker,
  fileHasher = hashFile,
} = {}) {
  const app = await pathStatus(paths.appPath);
  if (!app.present) {
    return {
      installed: false,
      running: false,
      appPath: paths.appPath,
      session: { status: 'unavailable', stores: {} },
      browser: { available: false },
      compatibility: { status: 'app_not_found', fingerprint: null },
    };
  }

  const [metadata, running, manifest, hatchSource, protocolSource, nodeId, httpStorage, webkitStorage] = await Promise.all([
    metadataReader(paths),
    processChecker(paths.executable),
    readFile(paths.browserManifest, 'utf8').then(JSON.parse),
    readFile(paths.hatchBundle, 'utf8'),
    readFile(paths.browserProtocol, 'utf8'),
    pathStatus(paths.nodeId),
    pathStatus(paths.httpStorage),
    pathStatus(paths.webkitStorage),
  ]);

  const [hatchHash, protocolHash] = await Promise.all([
    fileHasher(paths.hatchBundle),
    fileHasher(paths.browserProtocol),
  ]);
  const gatewayRoutes = extractGatewayRoutes(hatchSource);
  const browserCommands = extractBrowserCommands(protocolSource);

  const sessionPresent = httpStorage.present && webkitStorage.present;
  const fingerprint = [
    `${metadata.bundleId}@${metadata.version}+${metadata.build}`,
    `browser-${manifest.version}`,
    hatchHash.slice(0, 16),
    protocolHash.slice(0, 16),
  ].join('/');

  return {
    installed: true,
    running,
    appPath: paths.appPath,
    metadata,
    session: {
      status: sessionPresent ? 'store_present_unverified' : 'unavailable',
      stores: {
        http: httpStorage.present,
        webkit: webkitStorage.present,
        browserNodeId: nodeId.present,
      },
    },
    browser: {
      available: true,
      extensionVersion: manifest.version,
      commandSchema: paths.browserProtocol,
      commands: browserCommands,
      dispatch: 'unverified',
    },
    gateway: {
      catalogAvailable: gatewayRoutes.length > 0,
      routes: gatewayRoutes,
      transport: 'noise_attested',
    },
    compatibility: {
      status: 'capture_required',
      fingerprint,
      hashes: { hatch: hatchHash, browserProtocol: protocolHash },
    },
  };
}