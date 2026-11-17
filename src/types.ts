/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export const CAPABILITIES = ['read', 'write', 'delete', 'restore', 'execute', 'installDependencies', 'manageSoftware', 'autonomous'] as const;
export type Capability = typeof CAPABILITIES[number];
export type Grants = Record<Capability, boolean>;
export interface ComputerSettings {
  version: 1;
  grants: Grants;
  scope: 'workspace' | 'all';
  workspace: string;
  backupKeepDays: number;
  backupMaxBytes: number;
  maxFileBytes: number;
  taskTimeoutSeconds: number;
}
export interface FileScope {
  workspace: string;
  scope: 'workspace' | 'all';
  protectedRoots: string[];
  trustedWorkspace?: string;
  maxFileBytes: number;
}
export interface BackupPolicy { keepDays: number; maxBytes: number }
export interface BackupEntry {
  id: string;
  path: string;
  createdAt: string;
  size: number;
  sha256: string;
  reason: 'overwrite' | 'delete' | 'restore';
}
export interface FileInfo { path: string; kind: 'file' | 'directory'; size: number; modifiedAt: string }
export interface FileRead { path: string; text: string; sha256: string; totalBytes: number; truncated: boolean; offset: number; nextOffset?: number }
export interface FileMutation { path: string; bytes?: number; sha256?: string; backupId?: string; outcome: 'created' | 'updated' | 'deleted' | 'restored' }
export type FileOperation =
  | { action: 'list'; path?: string; offset?: number; limit?: number }
  | { action: 'search'; path?: string; query: string; content?: boolean; offset?: number; limit?: number }
  | { action: 'read'; path: string; offset?: number; limit?: number }
  | { action: 'write'; path: string; text: string; expectedSha256?: string; createOnly?: boolean }
  | { action: 'edit'; path: string; find: string; replace: string; expectedSha256: string }
  | { action: 'delete'; path: string; expectedSha256: string }
  | { action: 'mkdir'; path: string }
  | { action: 'backups'; offset?: number; limit?: number }
  | { action: 'restore'; backupId: string; expectedSha256?: string; createOnly?: boolean }
  | { action: 'document'; path: string; title: string; paragraphs: string[]; format: 'docx' | 'md' | 'html'; expectedSha256?: string; createOnly?: boolean }
  | { action: 'execute'; runtime: 'node' | 'powershell'; code: string; inputs?: { path: string; name: string }[]; outputs?: { name: string; path: string; expectedSha256?: string; createOnly?: boolean }[]; timeoutSeconds?: number }
  | { action: 'deliver'; path: string };
export type TaskOrigin = { kind: 'web' | 'qq' | 'autonomy'; sessionId: string; sender?: string; account?: string };
export interface TaskSnapshot { id: string; origin: TaskOrigin; settings: ComputerSettings; startedAt: string }
export interface TaskResult { id: string; state: 'completed' | 'failed' | 'cancelled'; steps: { action: string; ok: boolean; result?: unknown; error?: string }[] }
export class ComputerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ComputerError'; }
}
