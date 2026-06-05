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

const KOTLIN_LSP_VERSION = process.env.KOTLIN_LSP_VERSION || '262.4739.0';
// Standalone Kotlin LSP distribution (not the VS Code `.vsix`). Asset names follow
// `kotlin-server-<version><archSuffix>.<ext>`, where x64 has no arch suffix and arm64
// adds `-aarch64`, and the extension is platform specific.
// See https://github.com/Kotlin/kotlin-lsp/releases
const PLATFORM_ARCH_TO_ASSET = {
  darwin: {
    x64: { suffix: '', ext: 'sit' },
    arm64: { suffix: '-aarch64', ext: 'sit' },
  },
  linux: {
    x64: { suffix: '', ext: 'tar.gz' },
    arm64: { suffix: '-aarch64', ext: 'tar.gz' },
  },
  win32: {
    x64: { suffix: '', ext: 'win.zip' },
    arm64: { suffix: '-aarch64', ext: 'win.zip' },
  },
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, '..');
const installRoot = path.join(extensionRoot, 'server', 'kotlin-lsp');
const versionFile = path.join(installRoot, '.kotlin-lsp-version');
const launcherFile = path.join(installRoot, '.launcher-path');
// Ordered by preference. `bin/intellij-server` is the current entrypoint; `kotlin-lsp.sh`
// is deprecated (it just execs intellij-server and warns) but kept as a fallback.
const launcherCandidates =
  process.platform === 'win32'
    ? ['intellij-server.bat', 'kotlin-lsp.bat', 'kotlin-lsp.cmd', 'languageServer64.exe']
    : ['intellij-server', 'kotlin-lsp.sh', 'languageServer'];

async function main() {
  const { suffix: assetSuffix, ext: archiveExt } = resolveAsset();
  const archiveBase = `kotlin-server-${KOTLIN_LSP_VERSION}${assetSuffix}.${archiveExt}`;
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

    log(`Downloading kotlin-lsp ${KOTLIN_LSP_VERSION} (${archiveBase})...`);
    await downloadFile(archiveUrl, tmpArchive);

    const expectedSha = await getExpectedSha(checksumUrl);
    const actualSha = await getFileSha256(tmpArchive);
    if (expectedSha !== actualSha) {
      throw new Error(`Checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
    }
    log('Checksum verified.');

    await rm(installRoot, { recursive: true, force: true });
    await mkdir(installRoot, { recursive: true });

    extract(tmpArchive, installRoot, archiveExt);

    // The standalone archive nests everything under a single
    // `kotlin-server-<version>/` directory — flatten it into installRoot.
    await flattenSingleRootDir(installRoot);

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

function resolveAsset() {
  const byArch = PLATFORM_ARCH_TO_ASSET[process.platform];
  if (!byArch) {
    throw new Error(`Unsupported platform: ${process.platform}.`);
  }

  const asset = byArch[process.arch];
  if (!asset) {
    throw new Error(`Unsupported architecture: ${process.arch}. Supported: x64, arm64.`);
  }

  return asset;
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

function extract(archivePath, destination, ext) {
  // `.sit` (macOS) and `.win.zip` (Windows) are zip containers; `.tar.gz` is a gzip tarball.
  let result;
  if (ext === 'tar.gz') {
    result = spawnSync('tar', ['-xzf', archivePath, '-C', destination], { stdio: 'inherit' });
  } else {
    result = spawnSync('unzip', ['-q', '-o', archivePath, '-d', destination], { stdio: 'inherit' });
  }

  if (result.error) {
    throw new Error(`Extraction failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Extraction exited with status ${result.status}`);
  }
}

// If the archive extracted to a single wrapper directory, hoist its contents up
// into `root` so the launcher lands at a predictable top-level path.
async function flattenSingleRootDir(root) {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    return;
  }

  const nested = path.join(root, entries[0].name);
  const result = spawnSync(
    'sh',
    ['-c', `mv "${nested}"/* "${nested}"/.[!.]* "${root}/" 2>/dev/null; rm -rf "${nested}"`],
    { stdio: 'inherit' }
  );
  if (result.error) {
    throw new Error(`Failed to flatten archive root: ${result.error.message}`);
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
  // Honor launcherCandidates priority rather than directory order, so a preferred
  // launcher nested in bin/ wins over a less-preferred one at the root.
  for (const name of launcherCandidates) {
    const match = await findFileNamed(rootDir, name);
    if (match) {
      return match;
    }
  }

  return null;
}

async function findFileNamed(rootDir, name) {
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
      if (entry.isFile() && entry.name === name) {
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
