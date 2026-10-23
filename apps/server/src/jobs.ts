/**
 * 长任务与进度事件。
 *
 * 生成、导入都是「几秒到几十秒」的任务，用同步 HTTP 响应等着会撞上浏览器/代理超时，
 * 而且中途没有任何反馈。所以：`POST` 建任务立即返回 `jobId`，进度走 SSE
 * （TD 5.4 的事件名：job.created / job.progress / job.log / job.done / job.error）。
 *
 * 事件带自增 `seq` 并保留历史，是为了解决 SSE 的经典竞态：客户端拿到 jobId 之后
 * 才去连 `/events`，此间发出的事件不能丢。连接时带 `?from=<seq>` 就能补齐。
 *
 * 任务表只放内存：它是「这一次运行」的运行时状态，进程重启后重跑一次即可。
 * 落盘的是结果（generation 目录 + manifest），不是任务队列。
 */

import { randomUUID } from 'node:crypto';

import { NotFoundError } from './store.js';

export type JobKind = 'generate' | 'import';
export type JobState = 'queued' | 'running' | 'done' | 'error';

export type JobEventType = 'job.created' | 'job.progress' | 'job.log' | 'job.done' | 'job.error';

export interface JobEvent {
  seq: number;
  type: JobEventType;
  at: string;
  data: Record<string, unknown>;
}

export interface Job {
  id: string;
  kind: JobKind;
  projectId: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  events: JobEvent[];
  result?: unknown;
  error?: string;
}

export type JobListener = (event: JobEvent) => void;

/** 单个任务最多保留的事件数：日志可以刷屏，但内存不能跟着涨 */
const MAX_EVENTS = 500;

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<JobListener>>();

  create(kind: JobKind, projectId: string): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      kind,
      projectId,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.jobs.set(job.id, job);
    this.emit(job, 'job.created', { kind, projectId });
    return job;
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (job === undefined) throw new NotFoundError(`任务不存在：${id}`);
    return job;
  }

  find(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  running(projectId: string, kind: JobKind): Job | undefined {
    for (const job of this.jobs.values()) {
      if (job.projectId === projectId && job.kind === kind && (job.state === 'queued' || job.state === 'running')) {
        return job;
      }
    }
    return undefined;
  }

  progress(id: string, data: Record<string, unknown>): void {
    const job = this.get(id);
    job.state = 'running';
    this.emit(job, 'job.progress', data);
  }

  log(id: string, message: string): void {
    this.emit(this.get(id), 'job.log', { message });
  }

  done(id: string, result: unknown): void {
    const job = this.get(id);
    job.state = 'done';
    job.result = result;
    this.emit(job, 'job.done', { result });
  }

  fail(id: string, message: string): void {
    const job = this.get(id);
    job.state = 'error';
    job.error = message;
    this.emit(job, 'job.error', { message });
  }

  /** 订阅：先补齐 `from` 之后的历史事件，再收后续的。返回取消订阅函数 */
  subscribe(id: string, listener: JobListener, from = 0): () => void {
    const job = this.get(id);
    for (const event of job.events) {
      if (event.seq > from) listener(event);
    }
    const set = this.listeners.get(id) ?? new Set<JobListener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => set.delete(listener);
  }

  /** 测试用：清空（避免用例间互相影响） */
  clear(): void {
    this.jobs.clear();
    this.listeners.clear();
  }

  private emit(job: Job, type: JobEventType, data: Record<string, unknown>): void {
    const event: JobEvent = {
      seq: job.events.length === 0 ? 1 : job.events[job.events.length - 1]!.seq + 1,
      type,
      at: new Date().toISOString(),
      data,
    };
    job.events.push(event);
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    job.updatedAt = event.at;
    for (const listener of this.listeners.get(job.id) ?? []) listener(event);
  }
}

/** 对外暴露的任务视图：不发事件明细（可能很多），只给状态与结果 */
export function jobView(job: Job): {
  id: string;
  kind: JobKind;
  projectId: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  result?: unknown;
  error?: string;
} {
  return {
    id: job.id,
    kind: job.kind,
    projectId: job.projectId,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastSeq: job.events.length === 0 ? 0 : job.events[job.events.length - 1]!.seq,
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}
