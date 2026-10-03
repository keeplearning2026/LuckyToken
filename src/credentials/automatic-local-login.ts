import type {
  AuthInteractionChannel,
  ProviderProfileAuthCommandHandler,
  ProviderProfileAuthCommandOutcome,
} from "@token/application-control-plane/control-plane";

export interface AutomaticLocalLoginResult {
  readonly providerId?: string;
  readonly outcome: ProviderProfileAuthCommandOutcome;
}

/** Runs the same query/login commands as the UI. Provider implementations,
 * credential references and Profile storage stay behind that existing seam. */
export function createAutomaticLocalLogin(options: {
  readonly auth: ProviderProfileAuthCommandHandler;
  readonly onResult?: (result: AutomaticLocalLoginResult) => void | Promise<void>;
}) {
  let enabled = false;
  let started = false;
  let closed = false;
  let controller: AbortController | undefined;
  let pending = Promise.resolve();

  const report = (result: AutomaticLocalLoginResult): void => {
    try {
      void Promise.resolve(options.onResult?.(Object.freeze(result))).catch(() => undefined);
    } catch {
      // Reporting never changes a login result or prevents the next Provider.
    }
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    const interaction: AuthInteractionChannel = {
      signal,
      notify: async () => undefined,
      prompt: async () => { throw new Error("Automatic local login cannot prompt"); },
    };
    let query: Awaited<ReturnType<ProviderProfileAuthCommandHandler>>;
    try {
      query = await options.auth({ command: "query" }, interaction);
    } catch {
      if (!signal.aborted) report({ outcome: "failed" });
      return;
    }
    if (signal.aborted) return;
    if (query.outcome !== "ok" || query.options === undefined) {
      report({ outcome: query.outcome === "ok" ? "unavailable" : query.outcome });
      return;
    }
    for (const provider of query.options.providers) {
      if (signal.aborted) return;
      if (!provider.acquisitionOptions.some(
        (option) => option.kind === "local_oauth" && option.state === "available",
      )) continue;
      let outcome: ProviderProfileAuthCommandOutcome;
      try {
        const result = await options.auth({
          command: "login",
          providerId: provider.providerId,
          acquisitionKind: "local_oauth",
          displayName: `${provider.name} local login`,
        }, interaction);
        outcome = result.outcome;
      } catch {
        outcome = "failed";
      }
      report({ providerId: provider.providerId, outcome });
    }
  };

  const schedule = (): void => {
    const batch = new AbortController();
    controller = batch;
    pending = pending.then(() => run(batch.signal)).catch(() => {
      if (!batch.signal.aborted) report({ outcome: "failed" });
    }).finally(() => {
      if (controller === batch) controller = undefined;
    });
  };

  return Object.freeze({
    /** Start only after Backend initialization. Earlier setting changes record
     * policy without starting credential operations during bootstrap. */
    start(): void {
      if (closed || started) return;
      started = true;
      if (enabled) schedule();
    },
    /** Disabling cancels the batch. A rapid re-enable waits for it to finish. */
    setEnabled(value: boolean): void {
      if (closed || value === enabled) return;
      enabled = value;
      controller?.abort();
      if (enabled && started) schedule();
    },
    async close(): Promise<void> {
      closed = true;
      enabled = false;
      controller?.abort();
      await pending;
    },
  });
}
