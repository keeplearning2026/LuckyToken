export interface ClientProtocolHandler {
  readonly method: string;
  readonly pathname: string;
  handle(request: Request): Promise<Response>;
}

export interface HttpBoundaryDependencies {
  readonly clientProtocols: readonly ClientProtocolHandler[];
  readonly requestTimeoutMs: number | undefined;
  readonly shutdownSignal: AbortSignal | undefined;
}

export class HttpRequestAbortedError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super("HTTP request is no longer writable");
    this.name = "HttpRequestAbortedError";
    this.reason = reason;
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

  try {
    assertWritable(lifecycle);
    const protocol = selectClientProtocol(dependencies.clientProtocols, request);
    if (protocol === undefined) {
      lifecycle.markDelivered();
      return new Response(null, { status: 404 });
    }
    const routedRequest = new Request(request, { signal: lifecycle.signal });
    const response = await raceWithRequestSignal(
      protocol.handle(routedRequest),
      lifecycle.signal,
    );
    assertWritable(lifecycle);
    lifecycle.markDelivered();
    return response;
  } catch (error) {
    if (lifecycle.signal.aborted || error instanceof HttpRequestAbortedError) {
      throw new HttpRequestAbortedError(lifecycle.signal.reason);
    }
    return new Response(null, { status: 500 });
  } finally {
    lifecycle.dispose();
  }
}
