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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const CONFIG_SECTION = 'kotlin-lsp';
const OUTPUT_CHANNEL_NAME = 'Kotlin LSP';

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
    ? [path.join(installRoot, 'kotlin-lsp.cmd'), path.join(installRoot, 'bin', 'languageServer64.exe')]
    : [path.join(installRoot, 'kotlin-lsp.sh'), path.join(installRoot, 'bin', 'languageServer')];
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
    ? ['kotlin-lsp.cmd', 'languageServer64.exe']
    : ['kotlin-lsp.sh', 'languageServer'];
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
