import {
  handleHttpRequest,
  type ClientProtocolHandler,
  type HttpBoundaryDependencies,
} from "./http.js";

export interface LuckyTokenRuntime {
  handle(request: Request): Promise<Response>;
}

export interface LuckyTokenRuntimeOptions {
  readonly clientProtocols: readonly ClientProtocolHandler[];
  readonly requestTimeoutMs?: number;
  readonly shutdownSignal?: AbortSignal;
}

function snapshotClientProtocol(
  protocol: ClientProtocolHandler,
): ClientProtocolHandler {
  const method = protocol.method;
  const pathname = protocol.pathname;
  const handle = protocol.handle;
  if (method.length === 0 || pathname.length === 0 || !pathname.startsWith("/")) {
    throw new Error("Client Protocol route must have a method and absolute pathname");
  }
  return Object.freeze({
    method,
    pathname,
    handle: (request: Request) => handle.call(protocol, request),
  });
}

export function createLuckyTokenRuntime(
  options: LuckyTokenRuntimeOptions,
): LuckyTokenRuntime {
  const clientProtocols = options.clientProtocols.map(snapshotClientProtocol);
  const routeKeys = new Set<string>();
  for (const protocol of clientProtocols) {
    const key = `${protocol.method} ${protocol.pathname}`;
    if (routeKeys.has(key)) throw new Error(`Duplicate Client Protocol route: ${key}`);
    routeKeys.add(key);
  }
  const dependencies: HttpBoundaryDependencies = Object.freeze({
    clientProtocols: Object.freeze(clientProtocols),
    requestTimeoutMs: options.requestTimeoutMs,
    shutdownSignal: options.shutdownSignal,
  });
  return Object.freeze({
    handle: (request: Request) => handleHttpRequest(dependencies, request),
  });
}
