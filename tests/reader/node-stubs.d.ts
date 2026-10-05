// 测试文件在 Node 环境运行，仅测试用到 fs/path/os/child_process/process 的最小子集。
// 不引入完整 @types/node，避免把 Node 全局泄漏到扩展源码类型检查面。

declare module "node:fs" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function readFileSync(path: string, options?: { encoding?: string } | string): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function statSync(path: string): { isDirectory(): boolean };
  export function existsSync(path: string): boolean;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean; maxRetries?: number }
  ): void;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: { cwd?: string; encoding: "utf8" }
  ): SpawnSyncResult;
}

declare const process: {
  cwd(): string;
  execPath: string;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};
