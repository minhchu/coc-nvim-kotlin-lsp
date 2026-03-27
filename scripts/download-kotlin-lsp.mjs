#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const KOTLIN_LSP_VERSION = '262.2310.0';
const PLATFORM_ARCH_TO_SUFFIX = {
  darwin: {
    x64: 'mac-x64',
    arm64: 'mac-aarch64',
  },
  linux: {
    x64: 'linux-x64',
    arm64: 'linux-aarch64',
  },
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, '..');
const installRoot = path.join(extensionRoot, 'server', 'kotlin-lsp');
const versionFile = path.join(installRoot, '.kotlin-lsp-version');
const launcherFile = path.join(installRoot, '.launcher-path');
const launcherCandidates =
  process.platform === 'win32'
    ? ['kotlin-lsp.cmd', 'languageServer64.exe']
    : ['kotlin-lsp.sh', 'languageServer'];

async function main() {
  const assetSuffix = resolveAssetSuffix();
  const archiveBase = `kotlin-lsp-${KOTLIN_LSP_VERSION}-${assetSuffix}.zip`;
  const archiveUrl = `https://download-cdn.jetbrains.com/kotlin-lsp/${KOTLIN_LSP_VERSION}/${archiveBase}`;
  const checksumUrl = `${archiveUrl}.sha256`;

  const installedLauncher = await getInstalledLauncher();
  if (installedLauncher && (await isCurrentVersionInstalled())) {
    log(`kotlin-lsp ${KOTLIN_LSP_VERSION} already installed, skipping download.`);
    return;
  }

  const tmpArchive = path.join(os.tmpdir(), `coc-kotlin-lsp-${Date.now()}-${archiveBase}`);
  try {
    await mkdir(installRoot, { recursive: true });

    log(`Downloading kotlin-lsp ${KOTLIN_LSP_VERSION} (${assetSuffix})...`);
    await downloadFile(archiveUrl, tmpArchive);

    const expectedSha = await getExpectedSha(checksumUrl);
    const actualSha = await getFileSha256(tmpArchive);
    if (expectedSha !== actualSha) {
      throw new Error(`Checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
    }
    log('Checksum verified.');

    await rm(installRoot, { recursive: true, force: true });
    await mkdir(installRoot, { recursive: true });

    extractZip(tmpArchive, installRoot);
    const launcherPath = await findLauncher(installRoot);
    if (!launcherPath) {
      throw new Error(
        `Unable to locate launcher inside extracted archive. Tried: ${launcherCandidates.join(', ')}`
      );
    }

    await chmod(launcherPath, 0o755);
    await writeFile(versionFile, `${KOTLIN_LSP_VERSION}\n`, 'utf8');
    await writeFile(launcherFile, `${path.relative(installRoot, launcherPath)}\n`, 'utf8');
    log(`Installed kotlin-lsp launcher at ${path.relative(extensionRoot, launcherPath)}`);
  } finally {
    await rm(tmpArchive, { force: true });
  }
}

function resolveAssetSuffix() {
  const byArch = PLATFORM_ARCH_TO_SUFFIX[process.platform];
  if (!byArch) {
    throw new Error(
      `Unsupported platform: ${process.platform}. v1 supports macOS and Linux only.`
    );
  }

  const suffix = byArch[process.arch];
  if (!suffix) {
    throw new Error(
      `Unsupported architecture: ${process.arch}. Supported architectures: x64, arm64.`
    );
  }

  return suffix;
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function getExpectedSha(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download checksum (${response.status} ${response.statusText})`);
  }
  const text = await response.text();
  const hash = text.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`Invalid checksum format from ${url}`);
  }
  return hash.toLowerCase();
}

async function getFileSha256(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

function extractZip(archivePath, destination) {
  const result = spawnSync('unzip', ['-q', '-o', archivePath, '-d', destination], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw new Error(`Failed to execute unzip: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`unzip exited with status ${result.status}`);
  }
}

async function isCurrentVersionInstalled() {
  try {
    const version = (await readFile(versionFile, 'utf8')).trim();
    return version === KOTLIN_LSP_VERSION;
  } catch {
    return false;
  }
}

async function getInstalledLauncher() {
  try {
    const relativePath = (await readFile(launcherFile, 'utf8')).trim();
    if (relativePath.length === 0) {
      return null;
    }
    const fullPath = path.resolve(installRoot, relativePath);
    const fileStat = await stat(fullPath);
    return fileStat.isFile() ? fullPath : null;
  } catch {
    return null;
  }
}

async function findLauncher(rootDir) {
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdirSafe(current);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && launcherCandidates.includes(entry.name)) {
        return fullPath;
      }
    }
  }

  return null;
}

async function readdirSafe(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function log(message) {
  console.log(`[coc-kotlin-lsp] ${message}`);
}

main().catch((error) => {
  console.error(`[coc-kotlin-lsp] ${error.message}`);
  process.exitCode = 1;
});
