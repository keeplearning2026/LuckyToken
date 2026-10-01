/** Cancellation detaches only that waiter. The operation owns its bounded
 * lifetime; no waiter signal reaches it and nothing persists on completion. */
export function createKeyedSingleFlight<T>() {
  const pending = new Map<string, Promise<T>>();
  return Object.freeze({
    size: (): number => pending.size,
    async run(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted();
      let shared = pending.get(key);
      if (shared === undefined) {
        shared = Promise.resolve().then(operation).finally(() => {
          if (pending.get(key) === shared) pending.delete(key);
        });
        pending.set(key, shared);
      }
      if (signal === undefined) return shared;
      const result = shared;
      return new Promise<T>((resolveWait, rejectWait) => {
        const onAbort = (): void => {
          signal.removeEventListener("abort", onAbort);
          rejectWait(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void result.then(resolveWait, rejectWait).finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
      });
    },
  });
}
