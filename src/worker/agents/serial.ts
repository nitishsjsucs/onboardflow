// Promise-chain mutex. scanBlockers, refresh, reconcile and failure
// confirmation run through it, so a scheduled scan and an event-triggered scan
// never interleave across an await (Durable Object input gates do not block
// outbound I/O). A failed task does not poison the chain.
export class Serial {
  #chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }
}
