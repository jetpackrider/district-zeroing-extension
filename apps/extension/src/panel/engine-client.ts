import type { EngineGraph } from '@zd/contracts';
import type { WorkerRequest, WorkerResponse } from '../worker/protocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WorkerRequestBody = DistributiveOmit<WorkerRequest, 'id'>;

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; onProgress?: (done: number, total: number) => void };

/** Rejection reason for requests that were pending when the worker was restarted (cancel-solve). */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Promise wrapper around the engine Worker. The worker is single-threaded, so a long solve can only
 * be stopped by terminating it: `restart()` does that, rejects everything pending with
 * CancelledError, and starts a fresh worker initialised with the same graph.
 */
export class EngineClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private graph: EngineGraph | null = null;
  /** Worker generations started (1 + restarts). */
  generation = 0;
  /** Last measured graph upload (structured clone + worker side), ms. */
  lastInitMs = 0;

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.generation++;
    const worker = new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        p.onProgress?.(m.done, m.total);
        return;
      }
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    worker.onerror = (e) => {
      if (worker !== this.worker) return;
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'engine worker crashed'));
      this.pending.clear();
    };
    this.worker = worker;
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  /**
   * `transfer`: buffers to move to the worker instead of copying (e.g. the area mask, see
   * WorkerRequest `area`). They are unusable here afterwards, so pass buffers of copies.
   */
  request<T extends WorkerResponse>(req: WorkerRequestBody, onProgress?: (done: number, total: number) => void, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: WorkerResponse) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id } as WorkerRequest, transfer);
    });
  }

  init(graph: EngineGraph) {
    this.graph = graph;
    const t0 = performance.now();
    return this.request({ type: 'init', graph }).then((r) => {
      this.lastInitMs = performance.now() - t0;
      return r;
    });
  }

  /** Terminates the worker (stopping whatever it is computing) and starts a fresh one with the same graph. */
  restart(): Promise<unknown> {
    this.worker.terminate();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new CancelledError());
    this.spawn();
    return this.graph ? this.init(this.graph) : Promise.resolve();
  }

  terminate() {
    this.worker.terminate();
  }
}
