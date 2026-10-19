/**
 * CLI 的输入输出约定。
 *
 * 三条纪律（对应 TD 16.3/16.4）：
 * 1. **默认只读**：`gen` 不带 `--out` 只预览；任何写盘都要显式给路径。
 * 2. **退出码有语义**：0 成功 / 1 校验失败或存在差异 / 2 用法错误。
 *    1 与 2 必须分开——CI 上「代码有漂移」和「你把命令写错了」是完全不同的处理方式。
 * 3. **stdout 是数据，stderr 是给人看的**。`lint --format json` 的输出要能被
 *    `| jq` 直接消费，所以进度、警告、彩色标题一律走 stderr。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CliIO {
  /** 数据输出，可被管道消费 */
  stdout(text: string): void;
  /** 提示信息，永远走 stderr */
  stderr(text: string): void;
}

export const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
  stderr: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
};

export function resolvePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new UsageError(`文件不存在：${path}`);
    throw error;
  }
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** 字节数转人类可读，用于生成汇总 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 相对 cwd 的路径，日志里比绝对路径短得多 */
export function rel(cwd: string, path: string): string {
  if (!path.startsWith(cwd)) return path;
  const out = path.slice(cwd.length).replace(/^[/\\]/, '');
  return out.length === 0 ? '.' : out;
}
