import { NerdGraphError } from './errors.js';

type Waiter = {
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
};

export type SemaphoreStats = {
  readonly active: number;
  readonly pending: number;
  readonly limit: number;
};

/** Fair, abort-aware semaphore used to stay below New Relic's per-user limit. */
export class Semaphore {
  readonly limit: number;
  readonly maxPending: number;
  #active = 0;
  #queue: Waiter[] = [];

  constructor(limit: number, maxPending = limit * 50) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('Semaphore limit must be positive');
    if (!Number.isSafeInteger(maxPending) || maxPending < 0) {
      throw new RangeError('Semaphore pending limit must be non-negative');
    }
    this.limit = limit;
    this.maxPending = maxPending;
  }

  get stats(): SemaphoreStats {
    return { active: this.#active, pending: this.#queue.length, limit: this.limit };
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw this.#abortError(signal.reason);
    if (this.#active < this.limit && this.#queue.length === 0) return this.#grant();
    if (this.#queue.length >= this.maxPending) {
      throw new NerdGraphError('rate-limited', 'The local New Relic request queue is full');
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort =
        signal === undefined
          ? undefined
          : (): void => {
              const index = this.#queue.indexOf(waiter);
              if (index >= 0) this.#queue.splice(index, 1);
              reject(this.#abortError(signal.reason));
            };
      const waiter: Waiter = { resolve, reject, signal, onAbort };
      if (signal !== undefined && onAbort !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  #grant(): () => void {
    this.#active += 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.limit) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) return;
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      if (waiter.signal?.aborted === true) {
        waiter.reject(this.#abortError(waiter.signal.reason));
        continue;
      }
      waiter.resolve(this.#grant());
    }
  }

  #abortError(cause: unknown): NerdGraphError {
    return new NerdGraphError('cancelled', 'Request was cancelled', { cause });
  }
}
