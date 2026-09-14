function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface HostState {
  tail: Promise<void>;
  nextAllowedAt: number;
}

export class DomainLimiter {
  private readonly states = new Map<string, HostState>();

  constructor(private readonly delayMs: number) {}

  async run<T>(url: string, operation: () => Promise<T>): Promise<T> {
    const host = new URL(url).hostname.toLowerCase();
    const state = this.states.get(host) ?? { tail: Promise.resolve(), nextAllowedAt: 0 };
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = state.tail;
    state.tail = previous.then(() => slot);
    this.states.set(host, state);

    await previous;
    const waitMs = Math.max(0, state.nextAllowedAt - Date.now());
    if (waitMs) await sleep(waitMs);
    try {
      return await operation();
    } finally {
      state.nextAllowedAt = Date.now() + this.delayMs;
      release();
    }
  }
}
