/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, copyFile, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExecuteRequest = {
  runtime: 'node' | 'powershell';
  code: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
};
export type ExecuteResult = {
  status: 'completed' | 'timeout' | 'cancelled' | 'unavailable' | 'failed';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  elapsedMs: number;
  reason?: string;
};
export type ExecutorOptions = {
  scratchRoot: string;
  nodePath?: string;
  powershellPath?: string;
  helperPath?: string;
};

const MAX_CODE_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 300_000;
const HELPER_RESPONSE_LIMIT = 4 * 1024 * 1024;

function blank(status: ExecuteResult['status'], start: number, reason?: string): ExecuteResult {
  return { status, exitCode: null, stdout: '', stderr: '', truncated: false,
    elapsedMs: Date.now() - start, ...(reason ? { reason } : {}) };
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
async function validateCanonicalDirectory(root: string, target: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(target);
  if (!inside(absoluteRoot, absolute)) throw new Error('Task directory must be inside the owned scratch root.');
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Task paths cannot contain symbolic links or junctions.');
    if (cursor === path.dirname(cursor)) break;
  }
  const [canonicalRoot, canonical] = await Promise.all([realpath(absoluteRoot), realpath(absolute)]);
  if (!inside(canonicalRoot, canonical) || !(await lstat(canonical)).isDirectory()) {
    throw new Error('Task directory is outside the canonical scratch root.');
  }
  return canonical;
}
async function validateInputTree(root: string, state = { entries: 0 }): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (++state.entries > 10_000) throw new Error('Too many task input files.');
    const absolute = path.join(root, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) {
      throw new Error('Task input must contain ordinary files and directories only.');
    }
    if (stat.isDirectory()) await validateInputTree(absolute, state);
  }
}
function parseResult(text: string, start: number): ExecuteResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return blank('failed', start, 'Sandbox helper returned an invalid response; completion and cleanup are uncertain.'); }
  if (!raw || typeof raw !== 'object') return blank('failed', start, 'Sandbox helper response is missing.');
  const value = raw as Record<string, unknown>;
  const statuses = ['completed', 'timeout', 'cancelled', 'unavailable', 'failed'];
  if (typeof value.status !== 'string' || !statuses.includes(value.status) ||
      typeof value.stdout !== 'string' || typeof value.stderr !== 'string' ||
      typeof value.truncated !== 'boolean' || typeof value.profileDeleted !== 'boolean' ||
      !(value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))) {
    return blank('failed', start, 'Sandbox helper response did not match its contract; cleanup is uncertain.');
  }
  const status = value.profileDeleted ? value.status as ExecuteResult['status'] : 'failed';
  const profileId = typeof value.profileId === 'string' && /^WhaleLife\.Computer\.[0-9a-f]{32}$/.test(value.profileId)
    ? value.profileId : undefined;
  return { status, exitCode: value.exitCode as number | null, stdout: value.stdout, stderr: value.stderr,
    truncated: value.truncated, elapsedMs: Date.now() - start,
    ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason.slice(0, 1000) } : {}),
    ...(!value.profileDeleted ? { reason: `Sandbox profile cleanup was incomplete or unverified.${profileId ? ` Owned profile: ${profileId}.` : ''}` } : {}) };
}

/** Native Windows isolation only. cwd is an owned snapshot, never the user's source directory. */
export class WindowsExecutor {
  readonly #options: Required<ExecutorOptions>;
  constructor(options: ExecutorOptions) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    this.#options = {
      scratchRoot: path.resolve(options.scratchRoot),
      nodePath: options.nodePath ?? process.execPath,
      powershellPath: options.powershellPath ?? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      helperPath: options.helperPath ?? fileURLToPath(new URL('../native/SandboxRunner.exe', import.meta.url)),
    };
  }

  /** Read-only availability check; runtime compatibility is verified on each isolated launch. */
  async probe(): Promise<{ available: boolean; reason?: string; runtimes: string[] }> {
    if (process.platform !== 'win32') return { available: false, reason: 'Only Windows is supported.', runtimes: [] };
    try { await access(this.#options.helperPath); }
    catch { return { available: false, reason: 'The native Windows sandbox helper has not been built.', runtimes: [] }; }
    const runtimes: string[] = [];
    for (const [runtime, executable] of [['node', this.#options.nodePath], ['powershell', this.#options.powershellPath]]) {
      try { if ((await lstat(executable!)).isFile()) runtimes.push(runtime!); } catch { /* Missing optional runtime. */ }
    }
    return runtimes.length ? { available: true, runtimes } : { available: false, reason: 'No configured local runtime is available.', runtimes };
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const start = Date.now();
    if (request.signal?.aborted) return blank('cancelled', start, 'Cancelled before execution.');
    if (!['node', 'powershell'].includes(request.runtime) || typeof request.code !== 'string' ||
        !request.code.trim() || Buffer.byteLength(request.code, 'utf8') > MAX_CODE_BYTES || request.code.includes('\0') ||
        !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS ||
        !Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > MAX_OUTPUT_BYTES) {
      return blank('failed', start, 'Invalid runtime, code size, timeout, or output limit.');
    }
    const readiness = await this.probe();
    if (!readiness.available || !readiness.runtimes.includes(request.runtime)) {
      return blank('unavailable', start, readiness.reason ?? 'The requested runtime is unavailable.');
    }
    let runtimeDirectory: string | undefined;
    let result: ExecuteResult;
    try {
      const cwd = await validateCanonicalDirectory(this.#options.scratchRoot, request.cwd);
      await validateInputTree(cwd);
      if (request.signal?.aborted) return blank('cancelled', start, 'Cancelled before execution.');
      runtimeDirectory = path.join(this.#options.scratchRoot, `.runtime-${randomUUID()}`);
      await mkdir(runtimeDirectory);
      let executable: string;
      let args: string[];
      if (request.runtime === 'node') {
        executable = path.join(runtimeDirectory, 'node.exe');
        await copyFile(this.#options.nodePath, executable);
        const script = path.join(runtimeDirectory, 'task.cjs');
        await writeFile(script, request.code, { encoding: 'utf8', flag: 'wx' });
        // Input trees are validated before launch; avoid Node's realpath walk over
        // inaccessible volume ancestors. LPAC still enforces every actual file open.
        args = ['--no-addons', '--no-global-search-paths', '--preserve-symlinks', '--preserve-symlinks-main', script];
      } else {
        executable = this.#options.powershellPath;
        const script = path.join(runtimeDirectory, 'task.ps1');
        // Windows PowerShell 5.1 needs a BOM to interpret non-ASCII source as UTF-8.
        const preamble = '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\r\n';
        await writeFile(script, `\ufeff${preamble}${request.code}`, { encoding: 'utf8', flag: 'wx' });
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
      }
      if (request.signal?.aborted) result = blank('cancelled', start, 'Cancelled before execution.');
      else result = await this.#launch({ root: this.#options.scratchRoot, cwd, runtimeDirectory, executable,
        arguments: args, timeoutMs: request.timeoutMs, maxOutputBytes: request.maxOutputBytes }, request.signal, start);
    } catch (error) {
      result = blank('failed', start, error instanceof Error ? error.message.slice(0, 1000) : 'Execution preparation failed.');
    } finally {
      if (runtimeDirectory) {
        try {
          await validateCanonicalDirectory(this.#options.scratchRoot, runtimeDirectory);
          await rm(runtimeDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          // A failed cleanup must be visible; do not imply that a timed-out broker cleaned its profile.
          result = blank('failed', start, 'Owned runtime cleanup failed. Task outputs were not imported.');
        }
      }
    }
    return result!;
  }

  #launch(envelope: Record<string, unknown>, signal: AbortSignal | undefined, start: number): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      const child = spawn(this.#options.helperPath, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.SystemRoot || 'C:\\Windows' } });
      const chunks: Buffer[] = [];
      let length = 0, invalidOutput = false, settled = false, forced = false;
      const finish = (result: ExecuteResult): void => {
        if (settled) return;
        settled = true; clearTimeout(watchdog); signal?.removeEventListener('abort', cancel);
        child.stdin.destroy(); resolve(result);
      };
      const cancel = (): void => { if (!child.stdin.destroyed) child.stdin.end('cancel\n'); };
      // The helper observes EOF/cancel and owns the Job. Killing an unresponsive helper
      // closes its Job handle; profile cleanup then remains explicitly uncertain.
      const watchdog = setTimeout(() => { forced = true; child.kill(); }, Number(envelope.timeoutMs) + 20_000);
      watchdog.unref();
      child.stdin.on('error', () => { /* The close/error event decides the result. */ });
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > HELPER_RESPONSE_LIMIT) { invalidOutput = true; cancel(); return; }
        chunks.push(chunk);
      });
      child.stderr.on('data', () => { /* Drain trusted helper diagnostics without persisting arbitrary paths/content. */ });
      child.on('error', () => finish(blank('unavailable', start, 'The native sandbox helper could not start.')));
      child.on('close', (code) => {
        if (forced || invalidOutput || code !== 0) {
          finish(blank('failed', start, 'Sandbox helper ended without a verified result; completion and profile cleanup are uncertain.'));
        } else finish(parseResult(Buffer.concat(chunks).toString('utf8').trim(), start));
      });
      signal?.addEventListener('abort', cancel, { once: true });
      child.stdin.write(`${JSON.stringify(envelope)}\n`);
      if (signal?.aborted) cancel();
    });
  }
}
