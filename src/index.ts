import {
  ExtensionContext,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  services,
  Trace,
  window,
  workspace,
} from 'coc.nvim';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG_SECTION = 'kotlin-lsp';
const OUTPUT_CHANNEL_NAME = 'Kotlin LSP';
const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function activate(context: ExtensionContext): Promise<void> {
  const logger = getLogger(context);
  logger.info('coc-kotlin-lsp activating');

  const config = workspace.getConfiguration(CONFIG_SECTION);
  if (!config.get<boolean>('enable', true)) {
    logger.info('coc-kotlin-lsp is disabled by config: kotlin-lsp.enable=false');
    return;
  }

  const outputChannel = window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  const resolvedCommand = resolveCommand(context);
  if (!resolvedCommand) {
    const message =
      '[coc-kotlin-lsp] kotlin-lsp executable was not found. Run npm install in the extension folder or set "kotlin-lsp.command" in coc-settings.json.';
    logger.error(message);
    outputChannel.appendLine(message);
    window.showErrorMessage(message);
    return;
  }

  logger.info(
    `coc-kotlin-lsp loaded successfully. Using ${resolvedCommand.isBundled ? 'bundled' : 'configured'} server command: ${resolvedCommand.command}`
  );

  if (config.get<boolean>('java.check', true) && !resolvedCommand.isBundled) {
    warnIfJavaVersionUnsupported(outputChannel);
  }

  const args = normalizeArgs(config.get<string[]>('args', ['--stdio']));
  const serverOptions: ServerOptions = {
    command: resolvedCommand.command,
    args,
    options: {
      cwd: getWorkspaceCwd(),
      env: process.env,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'kotlin' }],
    outputChannel,
    progressOnInitialization: true,
    synchronize: {
      configurationSection: [CONFIG_SECTION],
    },
  };

  const client = new LanguageClient('kotlin-lsp', 'Kotlin Language Server', serverOptions, clientOptions);
  client.trace = parseTrace(config.get<string>('trace.server', 'off'));
  const register = (services as any).registerLanguageClient ?? (services as any).registLanguageClient;
  context.subscriptions.push(register.call(services, client));
  void client
    .onReady()
    .then(() => logger.info('kotlin-lsp language client is ready'))
    .catch((error) => logger.error(`kotlin-lsp failed to become ready: ${String(error)}`));

  if (resolvedCommand.isBundled) {
    void checkForUpdatesInBackground(context, logger);
  }
}

function getWorkspaceCwd(): string {
  const ws = workspace as any;
  return ws.root ?? ws.rootPath ?? ws.cwd;
}

function getLogger(context: ExtensionContext): {
  info: (...args: any[]) => void;
  error: (...args: any[]) => void;
} {
  const logger = (context as any).logger;
  if (logger && typeof logger.info === 'function' && typeof logger.error === 'function') {
    return logger;
  }
  return {
    info: (...args: any[]) => console.log(...args),
    error: (...args: any[]) => console.error(...args),
  };
}

function normalizeArgs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['--stdio'];
  }
  const args = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return args.length > 0 ? args : ['--stdio'];
}

function resolveCommand(context: ExtensionContext): { command: string; isBundled: boolean } | null {
  const config = workspace.getConfiguration(CONFIG_SECTION);
  const configured = config.get<string | null>('command', null);
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return {
      command: workspace.expand(configured.trim()),
      isBundled: false,
    };
  }

  const bundled = findBundledLauncher(context.extensionPath);
  return bundled ? { command: bundled, isBundled: true } : null;
}

function findBundledLauncher(extensionPath: string): string | null {
  const installRoot = path.join(extensionPath, 'server', 'kotlin-lsp');
  if (!existsSync(installRoot)) {
    return null;
  }

  const directCandidates = process.platform === 'win32'
    ? [path.join(installRoot, 'bin', 'intellij-server.bat'), path.join(installRoot, 'kotlin-lsp.cmd'), path.join(installRoot, 'bin', 'languageServer64.exe')]
    : [path.join(installRoot, 'bin', 'intellij-server'), path.join(installRoot, 'kotlin-lsp.sh'), path.join(installRoot, 'bin', 'languageServer')];
  for (const directPath of directCandidates) {
    if (isExecutableFile(directPath)) {
      return directPath;
    }
  }

  const markerPath = path.join(installRoot, '.launcher-path');
  if (existsSync(markerPath)) {
    const relative = readFileSync(markerPath, 'utf8').trim();
    if (relative.length > 0) {
      const fromMarker = path.resolve(installRoot, relative);
      if (isExecutableFile(fromMarker)) {
        return fromMarker;
      }
    }
  }

  const recursiveCandidates = process.platform === 'win32'
    ? ['intellij-server.bat', 'kotlin-lsp.cmd', 'languageServer64.exe']
    : ['intellij-server', 'kotlin-lsp.sh', 'languageServer'];
  return findFileRecursively(installRoot, recursiveCandidates);
}

function findFileRecursively(root: string, fileNames: string[]): string | null {
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch (_error) {
        continue;
      }

      if (stats.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (stats.isFile() && fileNames.includes(entry)) {
        return fullPath;
      }
    }
  }

  return null;
}

function isExecutableFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

async function checkForUpdatesInBackground(
  context: ExtensionContext,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  const config = workspace.getConfiguration(CONFIG_SECTION);
  if (!config.get<boolean>('autoUpdate', true)) {
    return;
  }

  const installRoot = path.join(context.extensionPath, 'server', 'kotlin-lsp');
  const lastCheckFile = path.join(installRoot, '.last-update-check');
  const versionFile = path.join(installRoot, '.kotlin-lsp-version');

  let installedVersion: string;
  try {
    installedVersion = readFileSync(versionFile, 'utf8').trim();
    if (!installedVersion) return;
  } catch {
    return;
  }

  try {
    const ts = Number(readFileSync(lastCheckFile, 'utf8').trim());
    if (!Number.isNaN(ts) && Date.now() - ts < UPDATE_CHECK_INTERVAL_MS) {
      return;
    }
  } catch {
    // file doesn't exist yet — proceed
  }

  // Write timestamp before the network call so concurrent startups don't all check.
  try {
    writeFileSync(lastCheckFile, `${Date.now()}\n`, 'utf8');
  } catch {
    // non-fatal
  }

  let latestVersion: string;
  try {
    const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: { 'User-Agent': 'coc-kotlin-lsp' },
    });
    if (!response.ok) {
      logger.error(`[coc-kotlin-lsp] Update check failed: ${response.status} ${response.statusText}`);
      return;
    }
    const data = await response.json() as { tag_name: string };
    latestVersion = data.tag_name.replace(/^v/, '');
    if (!latestVersion) return;
  } catch (err) {
    logger.error(`[coc-kotlin-lsp] Update check error: ${String(err)}`);
    return;
  }

  if (!isNewerVersion(latestVersion, installedVersion)) {
    return;
  }

  logger.info(`[coc-kotlin-lsp] New kotlin-lsp ${latestVersion} available (installed: ${installedVersion}). Downloading...`);

  const downloadScript = path.join(context.extensionPath, 'scripts', 'download-kotlin-lsp.mjs');
  const downloadError = await runChildScript(process.execPath, [downloadScript], { KOTLIN_LSP_VERSION: latestVersion });

  if (downloadError) {
    logger.error(`[coc-kotlin-lsp] Auto-update to ${latestVersion} failed: ${downloadError}`);
    return;
  }

  logger.info(`[coc-kotlin-lsp] kotlin-lsp updated to ${latestVersion}`);
  void window.showInformationMessage(`kotlin-lsp updated to ${latestVersion}. Reload to apply.`);
}

function isNewerVersion(candidate: string, installed: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(installed);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function runChildScript(executable: string, args: string[], extraEnv: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    const stderrChunks: string[] = [];
    const child = spawn(executable, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    child.on('close', (code) => resolve(code === 0 ? null : (stderrChunks.join('').trim() || `exit code ${code}`)));
    child.on('error', (err) => resolve(err.message));
  });
}

function parseTrace(trace: string): Trace {
  if (trace === 'verbose') return Trace.Verbose;
  if (trace === 'messages') return Trace.Messages;
  return Trace.Off;
}

function warnIfJavaVersionUnsupported(outputChannel: { appendLine(line: string): void }): void {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8' });
  const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();

  if (result.error) {
    const message = `[coc-kotlin-lsp] Could not execute "java -version": ${result.error.message}. Kotlin LSP requires Java 17+.`;
    outputChannel.appendLine(message);
    void window.showWarningMessage(message);
    return;
  }

  const major = parseJavaMajorVersion(combinedOutput);
  if (major === null || major < 17) {
    const versionDescription = major === null ? 'unknown' : major.toString();
    const message = `[coc-kotlin-lsp] Java 17+ is required. Detected Java major version: ${versionDescription}.`;
    outputChannel.appendLine(message);
    void window.showWarningMessage(message);
  }
}

function parseJavaMajorVersion(rawOutput: string): number | null {
  const match = rawOutput.match(/version "(.*?)"/);
  if (!match) {
    return null;
  }

  const version = match[1];
  if (version.startsWith('1.')) {
    const parts = version.split('.');
    return Number.parseInt(parts[1], 10) || null;
  }

  const majorSegment = version.split(/[._-]/)[0];
  const major = Number.parseInt(majorSegment, 10);
  return Number.isNaN(major) ? null : major;
}
