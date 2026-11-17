/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { win32, resolve } from 'node:path';
import type { ComputerSettings } from './types.ts';
import { CAPABILITIES, ComputerError } from './types.ts';

export function defaults(workspace: string): ComputerSettings {
  return {
    version: 1, grants: Object.fromEntries(CAPABILITIES.map(key => [key, false])) as ComputerSettings['grants'],
    scope: 'workspace', workspace: resolve(workspace), backupKeepDays: 30, backupMaxBytes: 1024 * 1024 * 1024,
    maxFileBytes: 16 * 1024 * 1024, taskTimeoutSeconds: 120,
  };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputerError('input', '参数必须是对象。');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new ComputerError('settings', `${name} 超出允许范围 ${min}–${max}。`);
  return value as number;
}
export function validateSettings(value: unknown): ComputerSettings {
  const input = object(value);
  const keys = ['version', 'grants', 'scope', 'workspace', 'backupKeepDays', 'backupMaxBytes', 'maxFileBytes', 'taskTimeoutSeconds'];
  if (Object.keys(input).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(input, k)))
    throw new ComputerError('settings', '设置字段不完整或含未知字段。');
  if (input.version !== 1 || !['workspace', 'all'].includes(input.scope as string))
    throw new ComputerError('settings', '设置版本或目录范围无效。');
  const grants = object(input.grants);
  if (Object.keys(grants).some(k => !CAPABILITIES.includes(k as never)) || CAPABILITIES.some(k => typeof grants[k] !== 'boolean'))
    throw new ComputerError('settings', '每项能力必须显式勾选或取消。');
  if (typeof input.workspace !== 'string' || !/^[A-Za-z]:[\\/]/.test(input.workspace) ||
      /[\u0000-\u001f<>"|?*]/.test(input.workspace) || input.workspace.slice(2).includes(':') ||
      input.workspace.split(/[\\/]/).some(s => s === '..' || /[. ]$/.test(s) || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s)))
    throw new ComputerError('settings', '工作目录必须是本机磁盘的绝对路径。');
  const workspace = win32.normalize(input.workspace);
  if (workspace === win32.parse(workspace).root) throw new ComputerError('settings', '不能将整个磁盘作为工作目录，请使用具体文件夹。');
  return {
    version: 1, grants: { ...grants } as ComputerSettings['grants'], scope: input.scope as ComputerSettings['scope'], workspace,
    backupKeepDays: integer(input.backupKeepDays, 1, 3650, '副本保留天数'),
    backupMaxBytes: integer(input.backupMaxBytes, 1024 * 1024, 1024 ** 4, '副本容量'),
    maxFileBytes: integer(input.maxFileBytes, 1024, 64 * 1024 * 1024, '单文件上限'),
    taskTimeoutSeconds: integer(input.taskTimeoutSeconds, 1, 300, '任务超时秒数'),
  };
}
export class SettingsStore {
  #revision = 0;
  #value: ComputerSettings;
  #tail: Promise<unknown> = Promise.resolve();
  private persist: (value: { revision: number; settings: ComputerSettings }) => Promise<void>;
  constructor(initial: ComputerSettings, persist: (value: { revision: number; settings: ComputerSettings }) => Promise<void>) {
    this.persist = persist;
    this.#value = structuredClone(initial);
  }
  static async load(workspace: string, stored: unknown, persist: (value: { revision: number; settings: ComputerSettings }) => Promise<void>) {
    const empty = stored == null || (typeof stored === 'object' && !Array.isArray(stored) && Object.keys(stored).length === 0);
    const row = empty ? undefined : object(stored);
    const store = new SettingsStore(row ? validateSettings(row.settings) : defaults(workspace), persist);
    if (row) store.#revision = integer(row.revision, 0, Number.MAX_SAFE_INTEGER - 1, '设置版本');
    return store;
  }
  snapshot() { return { revision: this.#revision, settings: structuredClone(this.#value) }; }
  async save(revision: unknown, input: unknown) {
    const update = this.#tail.then(async () => {
      if (revision !== this.#revision) throw new ComputerError('conflict', '设置已在其他窗口改变，请刷新后再保存。');
      const settings = validateSettings(input), next = this.#revision + 1;
      await this.persist({ revision: next, settings });
      this.#value = settings; this.#revision = next;
      return this.snapshot();
    });
    this.#tail = update.catch(() => undefined);
    return update;
  }
}
