import { createLogger, type Logger } from "@/lib/logger";
import type { AdvisoryLockSession } from "./advisoryLock";

/**
 * Test doubles shared by the worker's unit tests (never imported by production code; the worker
 * bundle only contains what `main.ts` reaches).
 */

export interface CapturedLogger {
  log: Logger;
  lines: Array<Record<string, unknown> & { msg?: string; level?: string }>;
  messages(): string[];
}

/** A debug-level pino logger whose JSON lines are captured in memory. */
export function captureLogger(): CapturedLogger {
  const lines: CapturedLogger["lines"] = [];
  const log = createLogger(
    { level: "debug" },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as CapturedLogger["lines"][number]);
      },
    },
  );
  return { log, lines, messages: () => lines.map((line) => String(line.msg)) };
}

/** Advisory locks of one fake database, shared by several fake sessions. */
export class FakeLockServer {
  readonly holders = new Map<bigint, FakeLockSession>();
}

/** In-memory `AdvisoryLockSession`: keys are exclusive across sessions of one `FakeLockServer`. */
export class FakeLockSession implements AdvisoryLockSession {
  readonly calls: string[] = [];
  /** Keys whose `tryAcquire` rejects (lock session unavailable). */
  readonly failing = new Set<bigint>();
  private gen = 0;
  private closed = false;
  private readonly lostListeners = new Set<
    (info: { generation: number; lostKeys: number }) => void
  >();

  constructor(
    private readonly server: FakeLockServer = new FakeLockServer(),
    readonly name = "session",
  ) {}

  async tryAcquire(key: bigint): Promise<boolean> {
    this.calls.push(`acquire:${key}`);
    if (this.closed) throw new Error("closed");
    if (this.failing.has(key)) throw new Error("lock session unavailable");
    if (this.server.holders.has(key)) return false;
    this.server.holders.set(key, this);
    return true;
  }

  async release(key: bigint): Promise<void> {
    this.calls.push(`release:${key}`);
    if (this.server.holders.get(key) === this) this.server.holders.delete(key);
  }

  isHeld(key: bigint): boolean {
    return this.server.holders.get(key) === this;
  }

  async withLock<T>(key: bigint, fn: () => Promise<T>) {
    if (!(await this.tryAcquire(key))) return { acquired: false } as const;
    try {
      return { acquired: true, value: await fn() } as const;
    } finally {
      await this.release(key);
    }
  }

  async close(): Promise<void> {
    this.calls.push("close");
    this.closed = true;
    this.freeKeys();
  }

  async connect(): Promise<void> {}

  generation(): number {
    return this.gen;
  }

  onSessionLost(listener: (info: { generation: number; lostKeys: number }) => void): () => void {
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
    };
  }

  /**
   * The database session dropped: every key this session held is free again, and the session-lost
   * listeners run synchronously (like the real session's `markLost`).
   */
  lose(): void {
    this.gen += 1;
    const lostKeys = this.freeKeys();
    if (this.closed) return;
    for (const listener of [...this.lostListeners]) listener({ generation: this.gen, lostKeys });
  }

  private freeKeys(): number {
    let freed = 0;
    for (const [key, holder] of this.server.holders) {
      if (holder === this) {
        this.server.holders.delete(key);
        freed += 1;
      }
    }
    return freed;
  }
}

/** A promise with its resolve/reject exposed. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
