export interface ClientProtocolHandler {
  readonly method: string;
  readonly pathname: string;
  handle(request: Request): Promise<Response>;
  /**
   * Ticket 18 correlation seam: the accepted request id assigned to
   * `request` while the handler is processing it, when the handler assigns
   * one. Opaque correlation only — the HTTP boundary never interprets it,
   * never generates one, and never imports the Request Ledger. The transport
   * uses it so a synthesized error response still carries the exact ledger
   * request id of a real accepted request.
   */
  readonly requestIdFor?: (request: Request) => string | undefined;
}

export interface HttpBoundaryDependencies {
  readonly clientProtocols: readonly ClientProtocolHandler[];
  readonly requestTimeoutMs: number | undefined;
  readonly shutdownSignal: AbortSignal | undefined;
}

export class HttpRequestAbortedError extends Error {
  readonly reason: unknown;
  /** Ticket 18 correlation: the accepted ledger request id of the aborted
   *  request, when the HTTP boundary could determine it (exact id, never
   *  generated here). */
  readonly requestId: string | undefined;

  constructor(reason?: unknown, requestId?: string) {
    super("HTTP request is no longer writable");
    this.name = "HttpRequestAbortedError";
    this.reason = reason;
    this.requestId = requestId;
  }
}

interface RequestLifecycle {
  readonly signal: AbortSignal;
  isWritable(): boolean;
  markDelivered(): void;
  dispose(): void;
}

function createRequestLifecycle(
  requestSignal: AbortSignal,
  shutdownSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): RequestLifecycle {
  const controller = new AbortController();
  let writable = true;
  let delivered = false;
  const removers: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason: unknown): void => {
    writable = false;
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const follow = (signal: AbortSignal): void => {
    if (signal.aborted) {
      abort(signal.reason);
      return;
    }
    const onAbort = (): void => abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    removers.push(() => signal.removeEventListener("abort", onAbort));
  };

  follow(requestSignal);
  if (shutdownSignal !== undefined) follow(shutdownSignal);
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => abort(new Error("HTTP request timed out")), timeoutMs);
  }

  return {
    signal: controller.signal,
    isWritable: () => writable && !controller.signal.aborted && !delivered,
    markDelivered: () => {
      if (!writable || controller.signal.aborted || delivered) {
        throw new HttpRequestAbortedError(controller.signal.reason);
      }
      delivered = true;
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const remove of removers) remove();
    },
  };
}

function assertWritable(lifecycle: RequestLifecycle): void {
  if (!lifecycle.isWritable()) {
    throw new HttpRequestAbortedError(lifecycle.signal.reason);
  }
}

async function raceWithRequestSignal<T>(
  value: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw new HttpRequestAbortedError(signal.reason);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new HttpRequestAbortedError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([value, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function selectClientProtocol(
  protocols: readonly ClientProtocolHandler[],
  request: Request,
): ClientProtocolHandler | undefined {
  const pathname = new URL(request.url).pathname;
  return protocols.find(
    (protocol) => protocol.method === request.method && protocol.pathname === pathname,
  );
}

export async function handleHttpRequest(
  dependencies: HttpBoundaryDependencies,
  request: Request,
): Promise<Response> {
  const lifecycle = createRequestLifecycle(
    request.signal,
    dependencies.shutdownSignal,
    dependencies.requestTimeoutMs,
  );
  let routedRequest: Request | undefined;
  let protocol: ClientProtocolHandler | undefined;

  try {
    assertWritable(lifecycle);
    protocol = selectClientProtocol(dependencies.clientProtocols, request);
    if (protocol === undefined) {
      lifecycle.markDelivered();
      return new Response(null, { status: 404 });
    }
    routedRequest = new Request(request, { signal: lifecycle.signal });
    const response = await raceWithRequestSignal(
      protocol.handle(routedRequest),
      lifecycle.signal,
    );
    assertWritable(lifecycle);
    lifecycle.markDelivered();
    return response;
  } catch (error) {
    // The exact accepted ledger request id, when the handler published one
    // for this request (opaque correlation; never guessed or generated).
    const requestId =
      routedRequest === undefined
        ? undefined
        : protocol?.requestIdFor?.(routedRequest);
    if (lifecycle.signal.aborted || error instanceof HttpRequestAbortedError) {
      throw new HttpRequestAbortedError(lifecycle.signal.reason, requestId);
    }
    return new Response(null, {
      status: 500,
      ...(requestId === undefined
        ? {}
        : { headers: { "x-luckytoken-request-id": requestId } }),
    });
  } finally {
    lifecycle.dispose();
  }
}
