/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { lstat, realpath, open, mkdir as fsMkdir, opendir, readFile, rename, unlink, link } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { ComputerError } from './types.ts';
import type { BackupEntry, BackupPolicy, FileInfo, FileMutation, FileRead, FileScope } from './types.ts';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SCAN = 10_000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const OWNER_FILE = '.owner.json';
const STORE_KIND = 'whalelife-computer-backups';
type StoredBackup = BackupEntry & { version: 1; owner: string };
type Page<T> = { items: T[]; total: number; truncated: boolean; nextOffset?: number };
type WriteOptions = { expectedSha256?: string; createOnly?: boolean; reason?: 'overwrite' | 'restore'; signal?: AbortSignal; backupPolicy: BackupPolicy };

function fail(code: string, message: string): never { throw new ComputerError(code, message); }
function checkSignal(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function same(a: string, b: string): boolean { return resolve(a).toLowerCase() === resolve(b).toLowerCase(); }
function within(root: string, target: string): boolean {
  const rel = relative(resolve(root).toLowerCase(), resolve(target).toLowerCase());
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function pageArgs(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_SCAN || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    fail('INVALID_PAGE', '分页范围无效。');
}
function page<T>(items: T[], offset: number, limit: number, truncated = false): Page<T> {
  const result: Page<T> = { items: items.slice(offset, offset + limit), total: items.length, truncated };
  if (offset + limit < items.length) result.nextOffset = offset + limit;
  return result;
}
function localPath(value: string, absolute = false): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f<>"|?*]/.test(value)) fail('INVALID_PATH', '文件路径无效。');
  const p = value.replaceAll('/', '\\');
  if (p.startsWith('\\') || /^[a-z]:[^\\]/i.test(p) || /^[a-z]:$/i.test(p)) fail('INVALID_PATH', '仅支持普通本地磁盘路径，不支持网络、设备或盘符相对路径。');
  const drive = /^[a-z]:\\/i.test(p);
  if (absolute && !drive) fail('INVALID_PATH', '需要本地绝对路径。');
  const rest = drive ? p.slice(3) : p;
  if (rest.includes(':')) fail('INVALID_PATH', '不支持备用数据流或特殊设备路径。');
  for (const segment of rest.split('\\')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' || /[ .]$/.test(segment) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment))
      fail('INVALID_PATH', '路径包含不支持的目录段或保留名称。');
  }
  return p;
}
function maxBytes(scope: FileScope): number {
  if (!Number.isSafeInteger(scope.maxFileBytes) || scope.maxFileBytes < 1 || scope.maxFileBytes > MAX_FILE_BYTES)
    fail('INVALID_LIMIT', '单文件大小限制无效。');
  return scope.maxFileBytes;
}
function policyValid(policy: BackupPolicy): void {
  if (!Number.isSafeInteger(policy.keepDays) || policy.keepDays < 1 || policy.keepDays > 36500 ||
      !Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > Number.MAX_SAFE_INTEGER)
    fail('INVALID_BACKUP_POLICY', '备份保留策略无效。');
}
function stamp(stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
function text(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('NOT_TEXT', '文件不是有效 UTF-8 文本，请使用二进制文件交付。'); }
}

/** A trusted broker for regular local files. External same-account directory races are not an OS sandbox. */
export class FileStore {
  readonly backupRoot: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: { backupRoot: string }) {
    if (process.platform !== 'win32') fail('UNSUPPORTED_PLATFORM', '文件插件首版仅支持 Windows。');
    this.backupRoot = resolve(localPath(options.backupRoot, true));
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /** Reject links, junctions and 8.3/path aliases in every existing component. */
  async #walk(path: string, allowMissing = false): Promise<void> {
    const root = parse(path).root;
    let current = root;
    for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      let stat: Stats;
      try { stat = await lstat(current); }
      catch (error) { if (allowMissing && missing(error)) return; throw error; }
      if (stat.isSymbolicLink()) fail('UNSAFE_LINK', '不允许通过链接或重解析目录访问文件。');
      const actual = await realpath(current);
      if (!same(actual, current)) fail('UNSAFE_ALIAS', '不允许使用链接、短路径或路径别名。');
      if (current !== path && !stat.isDirectory()) fail('NOT_DIRECTORY', '路径的父级不是目录。');
    }
  }

  #allowed(scope: FileScope, path: string, workspace: string): void {
    if (within(this.backupRoot, path)) fail('PROTECTED_PATH', '备份目录只能通过恢复接口访问。');
    const trusted = scope.trustedWorkspace ? resolve(localPath(scope.trustedWorkspace, true)) : undefined;
    const exception = trusted !== undefined && same(workspace, trusted) && within(trusted, path);
    for (const value of scope.protectedRoots) {
      const protectedRoot = resolve(localPath(value, true));
      if (within(protectedRoot, path) && !(exception && !within(trusted!, protectedRoot)))
        fail('PROTECTED_PATH', '目标属于宿主或插件受保护数据范围。');
    }
    if (scope.scope !== 'workspace' && scope.scope !== 'all') fail('INVALID_SCOPE', '文件访问范围无效。');
    if (scope.scope === 'workspace' && !within(workspace, path)) fail('OUTSIDE_SCOPE', '目标不在授权工作目录内。');
  }

  async #path(scope: FileScope, requested: string, allowMissing = false): Promise<string> {
    maxBytes(scope);
    const workspace = resolve(localPath(scope.workspace, true));
    this.#allowed(scope, workspace, workspace);
    // A custom workspace cannot contain protected roots either.
    const trusted = scope.trustedWorkspace && same(workspace, scope.trustedWorkspace);
    if (!trusted && scope.protectedRoots.some(p => within(workspace, resolve(localPath(p, true)))))
      fail('PROTECTED_PATH', '自定义工作目录不能包含受保护数据。');
    await this.#walk(workspace);
    if (!(await lstat(workspace)).isDirectory()) fail('NOT_DIRECTORY', '工作目录不是目录。');
    const path = resolve(workspace, localPath(requested));
    this.#allowed(scope, path, workspace);
    await this.#walk(path, allowMissing);
    return path;
  }

  async #read(scope: FileScope, requested: string, signal?: AbortSignal): Promise<{ path: string; bytes: Uint8Array; sha256: string; stamp: string }> {
    checkSignal(signal);
    const path = await this.#path(scope, requested);
    const handle = await open(path, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) fail('NOT_FILE', '目标不是普通文件。');
      if (before.nlink > 1) fail('UNSAFE_LINK', '不允许访问硬链接文件。');
      const limit = maxBytes(scope);
      if (before.size > limit) fail('FILE_TOO_LARGE', '文件超过单次处理上限。');
      const buffer = Buffer.alloc(Math.min(limit + 1, before.size + 1));
      let length = 0;
      while (length < buffer.length) {
        checkSignal(signal);
        const result = await handle.read(buffer, length, Math.min(65536, buffer.length - length), length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat();
      if (length > limit || after.size > limit) fail('FILE_TOO_LARGE', '文件超过单次处理上限。');
      if (stamp(before) !== stamp(after) || length !== after.size) fail('FILE_CHANGED', '读取期间文件发生变化，请重新读取。');
      await this.#path(scope, path);
      const current = await lstat(path);
      if (stamp(current) !== stamp(after)) fail('FILE_CHANGED', '读取期间目标被替换，请重新读取。');
      const bytes = buffer.subarray(0, length);
      return { path, bytes, sha256: sha(bytes), stamp: stamp(after) };
    } finally { await handle.close(); }
  }

  async readBytes(scope: FileScope, path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; path: string; sha256: string }> {
    const result = await this.#read(scope, path, signal);
    return { bytes: result.bytes, path: result.path, sha256: result.sha256 };
  }

  /** Offset and nextOffset are UTF-16 text positions; returned pages never split a surrogate pair. */
  async read(scope: FileScope, path: string, offset = 0, limit = 16000, signal?: AbortSignal): Promise<FileRead> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536)
      fail('INVALID_PAGE', '文本读取范围无效。');
    const result = await this.#read(scope, path, signal), source = text(result.bytes);
    let start = Math.min(offset, source.length), end = Math.min(source.length, start + limit);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(source[start] ?? '') && /[\uD800-\uDBFF]/.test(source[start - 1])) start--;
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(source[end])) end++;
    return { path: result.path, text: source.slice(start, end), sha256: result.sha256, totalBytes: result.bytes.length,
      offset: start, truncated: start > 0 || end < source.length, ...(end < source.length ? { nextOffset: end } : {}) };
  }

  async #children(scope: FileScope, path: string, signal?: AbortSignal): Promise<{ items: FileInfo[]; truncated: boolean }> {
    const folder = await this.#path(scope, path);
    if (!(await lstat(folder)).isDirectory()) fail('NOT_DIRECTORY', '目标不是目录。');
    const items: FileInfo[] = [];
    let visited = 0, truncated = false;
    for await (const item of await opendir(folder)) {
      checkSignal(signal);
      if (++visited > MAX_SCAN) { truncated = true; break; }
      if (item.isSymbolicLink()) continue;
      try {
        const candidate = await this.#path(scope, join(folder, item.name));
        const stat = await lstat(candidate);
        if ((!stat.isFile() && !stat.isDirectory()) || stat.nlink > 1 && stat.isFile()) continue;
        items.push({ path: candidate, kind: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtime.toISOString() });
      } catch (error) {
        if (error instanceof ComputerError || missing(error) || ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
    }
    items.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
    return { items, truncated };
  }

  async list(scope: FileScope, path = '', offset = 0, limit = 50, signal?: AbortSignal): Promise<Page<FileInfo>> {
    pageArgs(offset, limit);
    const result = await this.#children(scope, path, signal);
    return page(result.items, offset, limit, result.truncated);
  }

  async search(scope: FileScope, path: string, query: string, options: { content?: boolean; offset?: number; limit?: number; signal?: AbortSignal } = {}) {
    const { content = false, offset = 0, limit = 50, signal } = options;
    pageArgs(offset, limit);
    if (typeof query !== 'string' || !query.trim() || query.length > 256) fail('INVALID_QUERY', '搜索词需要为 1 至 256 个字符。');
    const needle = query.toLowerCase(), pending = [{ path: await this.#path(scope, path), depth: 0 }];
    const found: (FileInfo & { line?: number; preview?: string })[] = [];
    let scanned = 0, bytes = 0, truncated = false;
    while (pending.length && scanned < MAX_SCAN) {
      checkSignal(signal);
      const folder = pending.shift()!;
      const children = await this.#children(scope, folder.path, signal);
      truncated ||= children.truncated;
      for (const entry of children.items) {
        checkSignal(signal);
        if (++scanned > MAX_SCAN) { truncated = true; break; }
        if (entry.kind === 'directory') {
          if (folder.depth < 31) pending.push({ path: entry.path, depth: folder.depth + 1 }); else truncated = true;
        }
        if (!content) { if (entry.path.toLowerCase().includes(needle)) found.push(entry); continue; }
        if (entry.kind !== 'file' || entry.size > scope.maxFileBytes) continue;
        if (bytes + entry.size > MAX_SEARCH_BYTES) { truncated = true; continue; }
        bytes += entry.size;
        try {
          const source = text((await this.#read(scope, entry.path, signal)).bytes), index = source.toLowerCase().indexOf(needle);
          if (index >= 0) {
            const line = source.slice(0, index).split('\n').length;
            found.push({ ...entry, line, preview: source.slice(Math.max(0, index - 80), index + 160).replace(/[\r\n]/g, ' ') });
          }
        } catch (error) { checkSignal(signal); if (!(error instanceof ComputerError) && !missing(error)) throw error; }
      }
    }
    truncated ||= pending.length > 0;
    found.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
    return { ...page(found, offset, limit, truncated), scanned: Math.min(scanned, MAX_SCAN) };
  }

  async #writeNew(path: string, bytes: Uint8Array): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    let complete = false;
    try { await handle.writeFile(bytes); await handle.sync(); complete = true; }
    finally {
      await handle.close();
      if (!complete) await unlink(path);
    }
  }

  async #owner(): Promise<string> {
    await this.#walk(this.backupRoot, true);
    await fsMkdir(this.backupRoot, { recursive: true });
    await this.#walk(this.backupRoot);
    const marker = join(this.backupRoot, OWNER_FILE);
    try {
      const stat = await lstat(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4096) fail('BACKUP_UNSAFE', '备份所有权标记无效。');
      const value = JSON.parse(await readFile(marker, 'utf8')) as { kind?: string; owner?: string };
      if (value.kind !== STORE_KIND || !ID.test(value.owner ?? '')) fail('BACKUP_UNSAFE', '备份目录不属于当前插件。');
      return value.owner!;
    } catch (error) {
      if (!missing(error)) throw error;
      for await (const _entry of await opendir(this.backupRoot)) fail('BACKUP_UNSAFE', '已有非空目录缺少插件所有权标记，拒绝接管。');
      const owner = randomUUID();
      await this.#writeNew(marker, Buffer.from(JSON.stringify({ kind: STORE_KIND, owner })));
      return owner;
    }
  }

  async #entry(id: string, owner: string): Promise<StoredBackup> {
    if (!ID.test(id)) fail('INVALID_BACKUP', '恢复副本标识无效。');
    const path = join(this.backupRoot, `${id}.json`);
    await this.#walk(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink > 1 || stat.size > 16384) fail('BACKUP_CORRUPT', '恢复副本索引无效。');
    let data: StoredBackup;
    try { data = JSON.parse(await readFile(path, 'utf8')) as StoredBackup; } catch { return fail('BACKUP_CORRUPT', '恢复副本索引无法读取。'); }
    if (data.version !== 1 || data.owner !== owner || data.id !== id || !HASH.test(data.sha256) ||
        !Number.isSafeInteger(data.size) || data.size < 0 || data.size > MAX_FILE_BYTES ||
        !['overwrite', 'delete', 'restore'].includes(data.reason) || !Number.isFinite(Date.parse(data.createdAt)))
      fail('BACKUP_CORRUPT', '恢复副本索引校验失败。');
    localPath(data.path, true);
    return data;
  }

  async #entries(): Promise<StoredBackup[]> {
    const owner = await this.#owner(), items: StoredBackup[] = [], bodies = new Set<string>();
    let visited = 0;
    for await (const item of await opendir(this.backupRoot)) {
      if (++visited > 20002) fail('BACKUP_LIMIT', '备份目录条目过多，需要先整理。');
      if (item.name.endsWith('.bin') && ID.test(item.name.slice(0, -4))) {
        if (!item.isFile()) fail('BACKUP_UNSAFE', '备份内容路径异常，拒绝继续写入或清理。');
        bodies.add(item.name.slice(0, -4));
        continue;
      }
      if (!item.name.endsWith('.json') || !ID.test(item.name.slice(0, -5))) continue;
      if (!item.isFile()) fail('BACKUP_UNSAFE', '备份索引路径异常，拒绝继续写入或清理。');
      // Do not silently omit malformed owned-looking entries from capacity accounting.
      items.push(await this.#entry(item.name.slice(0, -5), owner));
    }
    const indexed = new Set(items.map(item => item.id));
    if ([...bodies].some(id => !indexed.has(id))) fail('BACKUP_CORRUPT', '存在未完成的恢复副本，需先核对备份存储；原文件未修改。');
    return items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  }

  async #prune(policy: BackupPolicy, reserve = 0): Promise<{ removed: number; bytes: number }> {
    policyValid(policy);
    if (reserve > policy.maxBytes) fail('BACKUP_CAPACITY', '单个恢复副本超过备份容量，未修改原文件。');
    const entries = await this.#entries(), cutoff = Date.now() - policy.keepDays * 86400000;
    let total = entries.reduce((n, entry) => n + entry.size, 0), removed = 0, bytes = 0;
    for (const entry of entries) {
      if (Date.parse(entry.createdAt) >= cutoff && total + reserve <= policy.maxBytes) continue;
      const file = join(this.backupRoot, `${entry.id}.bin`), index = join(this.backupRoot, `${entry.id}.json`);
      try {
        await this.#walk(file);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.nlink > 1 || stat.size !== entry.size) fail('BACKUP_CORRUPT', '备份内容或归属异常，未自动清理。');
        await unlink(file);
      } catch (error) { if (!missing(error)) throw error; }
      await this.#walk(index);
      await unlink(index);
      total -= entry.size; bytes += entry.size; removed++;
    }
    return { removed, bytes };
  }

  prune(policy: BackupPolicy): Promise<{ removed: number; bytes: number }> { return this.#serial(() => this.#prune(policy)); }

  async #backup(path: string, bytes: Uint8Array, reason: BackupEntry['reason'], policy: BackupPolicy): Promise<string> {
    await this.#prune(policy, bytes.length);
    const owner = await this.#owner(), id = randomUUID();
    const entry: StoredBackup = { version: 1, owner, id, path, size: bytes.length, sha256: sha(bytes), createdAt: new Date().toISOString(), reason };
    const body = join(this.backupRoot, `${id}.bin`), index = join(this.backupRoot, `${id}.json`);
    await this.#writeNew(body, bytes);
    try { await this.#writeNew(index, Buffer.from(JSON.stringify(entry))); }
    catch (error) { await unlink(body); throw error; }
    return id;
  }

  async #existing(scope: FileScope, path: string, options: Pick<WriteOptions, 'expectedSha256' | 'createOnly' | 'signal'>) {
    let existing: Awaited<ReturnType<FileStore['readBytes']>> | undefined;
    try { existing = await this.readBytes(scope, path, options.signal); } catch (error) { if (!missing(error)) throw error; }
    if (existing) {
      if (options.createOnly || !options.expectedSha256 || !HASH.test(options.expectedSha256) || options.expectedSha256 !== existing.sha256)
        fail('CONFLICT', '文件已经存在或内容已变化，请先读取并提供当前摘要。');
    } else if (options.expectedSha256) fail('CONFLICT', '预期的原文件不存在，请重新核对目标。');
    return existing;
  }

  async #write(scope: FileScope, requested: string, bytes: Uint8Array, options: WriteOptions): Promise<FileMutation> {
    checkSignal(options.signal); policyValid(options.backupPolicy);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes(scope)) fail('FILE_TOO_LARGE', '写入内容超过单文件上限。');
    const path = await this.#path(scope, requested, true);
    if (!(await lstat(dirname(path))).isDirectory()) fail('NOT_DIRECTORY', '父目录不存在或不是目录。');
    const existing = await this.#existing(scope, path, options);
    const backupId = existing ? await this.#backup(path, existing.bytes, options.reason ?? 'overwrite', options.backupPolicy) : undefined;
    const temp = join(dirname(path), `.computer-write-${randomUUID()}.tmp`);
    await this.#writeNew(temp, bytes);
    try {
      checkSignal(options.signal);
      await this.#path(scope, path, true);
      await this.#existing(scope, path, options);
      if (existing) await rename(temp, path);
      else {
        // link is an atomic create-if-absent; copyFile(EXCL) can expose partial bytes.
        try { await link(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('CONFLICT', '目标刚刚被创建，未覆盖。'); throw error; }
        await unlink(temp);
      }
    } catch (error) { try { await unlink(temp); } catch (cleanup) { if (!missing(cleanup)) throw cleanup; } throw error; }
    return { path, bytes: bytes.byteLength, sha256: sha(bytes), ...(backupId ? { backupId } : {}), outcome: options.reason === 'restore' ? 'restored' : existing ? 'updated' : 'created' };
  }

  write(scope: FileScope, path: string, bytes: Uint8Array, options: WriteOptions): Promise<FileMutation> {
    // Copy before enqueue: a caller cannot change the intended bytes while waiting.
    const frozen = Buffer.from(bytes);
    return this.#serial(() => this.#write(scope, path, frozen, options));
  }

  edit(scope: FileScope, path: string, find: string, replace: string, expectedSha256: string, policy: BackupPolicy, signal?: AbortSignal): Promise<FileMutation> {
    return this.#serial(async () => {
      if (typeof find !== 'string' || !find || typeof replace !== 'string') fail('INVALID_EDIT', '替换操作需要非空的查找文本。');
      const original = await this.#read(scope, path, signal), source = text(original.bytes);
      if (original.sha256 !== expectedSha256) fail('CONFLICT', '文件内容已变化，请重新读取。');
      const at = source.indexOf(find);
      if (at < 0 || source.indexOf(find, at + 1) >= 0) fail('AMBIGUOUS_EDIT', '查找文本必须恰好匹配一次。');
      return this.#write(scope, path, Buffer.from(source.slice(0, at) + replace + source.slice(at + find.length)), { expectedSha256, backupPolicy: policy, signal });
    });
  }

  delete(scope: FileScope, requested: string, expectedSha256: string, policy: BackupPolicy, signal?: AbortSignal): Promise<FileMutation> {
    return this.#serial(async () => {
      const original = await this.#read(scope, requested, signal);
      if (!HASH.test(expectedSha256) || original.sha256 !== expectedSha256) fail('CONFLICT', '删除前需要匹配当前文件摘要。');
      const backupId = await this.#backup(original.path, original.bytes, 'delete', policy);
      checkSignal(signal);
      if ((await this.#read(scope, original.path, signal)).sha256 !== expectedSha256) fail('CONFLICT', '文件已变化，未删除。');
      await this.#path(scope, original.path);
      await unlink(original.path);
      return { path: original.path, backupId, outcome: 'deleted' };
    });
  }

  mkdir(scope: FileScope, requested: string, signal?: AbortSignal): Promise<{ path: string; created: boolean }> {
    return this.#serial(async () => {
      checkSignal(signal);
      const path = await this.#path(scope, requested, true);
      try { if (!(await lstat(path)).isDirectory()) fail('NOT_DIRECTORY', '目标已存在且不是目录。'); return { path, created: false }; }
      catch (error) { if (!missing(error)) throw error; }
      const segments: string[] = [];
      let parent = path;
      while (true) {
        try { const stat = await lstat(parent); if (!stat.isDirectory()) fail('NOT_DIRECTORY', '父级不是目录。'); break; }
        catch (error) { if (!missing(error)) throw error; segments.unshift(parent); parent = dirname(parent); }
      }
      for (const segment of segments) {
        checkSignal(signal); await this.#path(scope, segment, true);
        try { await fsMkdir(segment); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await this.#path(scope, segment);
      }
      return { path, created: true };
    });
  }

  backups(scope: FileScope, offset = 0, limit = 50): Promise<Page<BackupEntry>> {
    return this.#serial(async () => {
      pageArgs(offset, limit);
      const allowed: BackupEntry[] = [];
      for (const entry of await this.#entries()) {
        try {
          await this.#path(scope, entry.path, true);
          const { version: _version, owner: _owner, ...item } = entry;
          allowed.push(item);
        } catch (error) { if (!(error instanceof ComputerError) && !missing(error)) throw error; }
      }
      return page(allowed.reverse(), offset, limit);
    });
  }

  restore(scope: FileScope, backupId: string, options: Omit<WriteOptions, 'reason'>): Promise<FileMutation> {
    return this.#serial(async () => {
      checkSignal(options.signal);
      const entry = await this.#entry(backupId, await this.#owner());
      await this.#path(scope, entry.path, true);
      const body = join(this.backupRoot, `${entry.id}.bin`);
      await this.#walk(body);
      const stat = await lstat(body);
      if (!stat.isFile() || stat.nlink > 1 || stat.size !== entry.size || stat.size > maxBytes(scope)) fail('BACKUP_CORRUPT', '备份内容或大小校验失败。');
      const bytes = await readFile(body);
      if (bytes.length !== entry.size || sha(bytes) !== entry.sha256) fail('BACKUP_CORRUPT', '恢复副本摘要校验失败。');
      return this.#write(scope, entry.path, bytes, { ...options, reason: 'restore' });
    });
  }
}
