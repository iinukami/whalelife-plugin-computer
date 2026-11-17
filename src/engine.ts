/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdir, mkdtemp, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStore } from './files.ts';
import { SettingsStore } from './settings.ts';
import { checkGrants, publicError } from './policy.ts';
import { ComputerError } from './types.ts';
import type { ComputerSettings, FileOperation, FileScope, TaskOrigin, TaskResult, TaskSnapshot } from './types.ts';
import type { ExecuteRequest, ExecuteResult } from './executor.ts';
import { makeDocument } from './documents.ts';

export interface Executor { execute(request: ExecuteRequest): Promise<ExecuteResult> }
export interface EngineOptions {
  settings: SettingsStore; files: FileStore; executor: Executor;
  scratchRoot: string; trustedWorkspace: string; protectedRoots: string[];
  signal?: AbortSignal;
  download: (path: string, scope: FileScope, sessionId: string) => Promise<unknown>;
}
export class ComputerEngine {
  #tail: Promise<unknown> = Promise.resolve();
  #tasks: { id: string; state: string; startedAt: string; origin: TaskOrigin; summary: string }[] = [];
  private options: EngineOptions;
  constructor(options: EngineOptions) { this.options = options; }
  tasks() { return structuredClone(this.#tasks); }
  scope(settings: ComputerSettings): FileScope {
    return { workspace: settings.workspace, scope: settings.scope, maxFileBytes: settings.maxFileBytes,
      trustedWorkspace: this.options.trustedWorkspace, protectedRoots: this.options.protectedRoots };
  }
  run(operations: FileOperation[], authorize: (settings: ComputerSettings) => Promise<TaskOrigin>, signal?: AbortSignal): Promise<TaskResult> {
    // This invocation, including its fixed operation list, is one plugin task. No model-supplied reusable permission token.
    const started = this.#tail.then(async () => {
      const signals = [this.options.signal, signal].filter((s): s is AbortSignal => !!s);
      const abort = signals.length ? AbortSignal.any(signals) : undefined;
      abort?.throwIfAborted();
      let chosen = this.options.settings.snapshot(), origin: TaskOrigin | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        origin = await authorize(chosen.settings); abort?.throwIfAborted();
        const latest = this.options.settings.snapshot();
        if (latest.revision === chosen.revision) break;
        chosen = latest; origin = undefined;
      }
      if (!origin) throw new ComputerError('conflict', '授权设置正在变化，请稍后重新发起任务。');
      const settings = chosen.settings; checkGrants(operations, settings.grants);
      const task: TaskSnapshot = { id: randomUUID(), origin, settings, startedAt: new Date().toISOString() };
      const entry = { id: task.id, state: 'running', startedAt: task.startedAt, origin, summary: operations.map(op => op.action).join(', ') };
      this.#tasks.unshift(entry); this.#tasks.splice(100);
      const result: TaskResult = { id: task.id, state: 'completed', steps: [] };
      const timeout = AbortSignal.timeout(settings.taskTimeoutSeconds * 1000);
      const taskSignal = abort ? AbortSignal.any([abort, timeout]) : timeout;
      for (const operation of operations) {
        try {
          taskSignal.throwIfAborted();
          const content = await this.perform(operation, task, taskSignal);
          const execution = operation.action === 'execute' ? content as ExecuteResult & { importError?: string; cleanupError?: string } : undefined;
          const ok = !execution || (execution.status === 'completed' && execution.exitCode === 0 && !execution.importError && !execution.cleanupError);
          result.steps.push({ action: operation.action, ok, result: content });
          if (!ok) { result.state = execution?.status === 'cancelled' || execution?.status === 'timeout' ? 'cancelled' : 'failed'; break; }
        } catch (error) {
          result.state = taskSignal.aborted ? 'cancelled' : 'failed';
          result.steps.push({ action: operation.action, ok: false, error: publicError(error).message });
          break;
        }
      }
      entry.state = result.state;
      return result;
    });
    this.#tail = started.catch(() => undefined);
    return started;
  }
  private async perform(op: FileOperation, task: TaskSnapshot, signal: AbortSignal): Promise<unknown> {
    const { files } = this.options, settings = task.settings, scope = this.scope(settings);
    const backupPolicy = { keepDays: settings.backupKeepDays, maxBytes: settings.backupMaxBytes };
    switch (op.action) {
      case 'list': return files.list(scope, op.path ?? '', op.offset, op.limit, signal);
      case 'search': return files.search(scope, op.path ?? '', op.query, { content: op.content, offset: op.offset, limit: op.limit, signal });
      case 'read': return files.read(scope, op.path, op.offset, op.limit, signal);
      case 'write': return files.write(scope, op.path, Buffer.from(op.text), { ...op, backupPolicy, signal });
      case 'edit': return files.edit(scope, op.path, op.find, op.replace, op.expectedSha256, backupPolicy, signal);
      case 'delete': return files.delete(scope, op.path, op.expectedSha256, backupPolicy, signal);
      case 'mkdir': return files.mkdir(scope, op.path, signal);
      case 'backups': return files.backups(scope, op.offset, op.limit);
      case 'restore': return files.restore(scope, op.backupId, { ...op, backupPolicy, signal });
      case 'deliver': {
        if (task.origin.kind === 'qq') throw new ComputerError('qq_file_contract_missing', 'QQ 尚未提供公开文件发送接口。文件已保留，可从 Web 下载；未发送文件。');
        return this.options.download(op.path, scope, task.origin.sessionId);
      }
      case 'document': {
        if (extname(op.path).toLowerCase() !== `.${op.format}`) throw new ComputerError('document', '文件扩展名须与文档格式一致。');
        const bytes = makeDocument(op.format, op.title, op.paragraphs);
        return files.write(scope, op.path, bytes, { ...op, backupPolicy, signal });
      }
      case 'execute': return this.execute(op, task, signal);
    }
  }
  private async execute(op: Extract<FileOperation, { action: 'execute' }>, task: TaskSnapshot, signal: AbortSignal) {
    const { scratchRoot, files, executor } = this.options;
    await mkdir(scratchRoot, { recursive: true });
    if ((await lstat(scratchRoot)).isSymbolicLink()) throw new ComputerError('path', '执行目录不能是链接。');
    const scratchBase = await realpath(scratchRoot), cwd = await mkdtemp(join(scratchBase, 'task-'));
    const scope = this.scope(task.settings), saved: unknown[] = [];
    let outcome: (ExecuteResult & { saved: unknown[]; outputsImported: boolean; importError?: string; cleanupError?: string }) | undefined;
    try {
      let inputBytes = 0;
      for (const input of op.inputs ?? []) {
        const source = await files.readBytes(scope, input.path, signal);
        inputBytes += source.bytes.byteLength;
        if (inputBytes > task.settings.maxFileBytes) throw new ComputerError('limit', '执行输入总量超过单任务限制。');
        await writeFile(join(cwd, input.name), source.bytes, { flag: 'wx', signal });
      }
      const run = await executor.execute({ runtime: op.runtime, code: op.code, cwd,
        timeoutMs: Math.min(op.timeoutSeconds ?? task.settings.taskTimeoutSeconds, task.settings.taskTimeoutSeconds) * 1000,
        maxOutputBytes: 24000, signal });
      outcome = { ...run, saved, outputsImported: false };
      if (run.status === 'completed' && run.exitCode === 0) {
        const outputScope: FileScope = { workspace: cwd, scope: 'workspace', maxFileBytes: task.settings.maxFileBytes, protectedRoots: [] };
        for (const output of op.outputs ?? []) {
          const source = await files.readBytes(outputScope, output.name, signal);
          saved.push(await files.write(scope, output.path, source.bytes, { expectedSha256: output.expectedSha256,
            createOnly: output.createOnly, backupPolicy: { keepDays: task.settings.backupKeepDays, maxBytes: task.settings.backupMaxBytes }, signal }));
        }
        outcome.outputsImported = true;
      }
    } catch (error) {
      if (!outcome) throw error;
      outcome.importError = publicError(error).message;
    } finally {
      try {
        const canonical = await realpath(cwd), rel = relative(scratchBase, canonical);
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || (await lstat(cwd)).isSymbolicLink()) throw new ComputerError('cleanup', '执行目录归属异常，未自动清理。');
        await rm(canonical, { recursive: true, force: true });
      } catch (error) {
        if (!outcome) throw error;
        outcome.cleanupError = '执行目录清理未完成；已保存结果保持有效，请检查本次任务资源。';
      }
    }
    return outcome!;
  }
}
