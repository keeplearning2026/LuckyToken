import {
  handleHttpRequest,
  type ClientProtocolHandler,
  type ClientProtocolRequestContext,
  type HttpBoundaryDependencies,
} from "./http.js";
import type { RequestJourneyObservationAuthority } from "./diagnostics/contract.js";

export interface TokenRuntime {
  handle(
    request: Request,
    context?: ClientProtocolRequestContext,
  ): Promise<Response>;
  /** Registered routes (method + pathname), for startup reporting and tests. */
  readonly routes: ReadonlyArray<Readonly<{ method: string; pathname: string }>>;
}

export interface TokenRuntimeOptions {
  readonly clientProtocols: readonly ClientProtocolHandler[];
  readonly requestTimeoutMs?: number;
  readonly shutdownSignal?: AbortSignal;
  readonly diagnostics?: RequestJourneyObservationAuthority;
  readonly createRequestId?: () => string;
}

function snapshotClientProtocol(
  protocol: ClientProtocolHandler,
): ClientProtocolHandler {
  const method = protocol.method;
  const pathname = protocol.pathname;
  const handle = protocol.handle;
  const requestIdFor = protocol.requestIdFor;
  if (method.length === 0 || pathname.length === 0 || !pathname.startsWith("/")) {
    throw new Error("Client Protocol route must have a method and absolute pathname");
  }
  return Object.freeze({
    method,
    pathname,
    handle: (request: Request, context?: ClientProtocolRequestContext) =>
      handle.call(protocol, request, context),
    ...(requestIdFor === undefined
      ? {}
      : { requestIdFor: (request: Request) => requestIdFor.call(protocol, request) }),
  });
}

export function createTokenRuntime(
  options: TokenRuntimeOptions,
): TokenRuntime {
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
    ...(options.diagnostics === undefined
      ? {}
      : { diagnostics: options.diagnostics }),
    ...(options.createRequestId === undefined
      ? {}
      : { createRequestId: options.createRequestId }),
  });
  return Object.freeze({
    handle: (request: Request, context?: ClientProtocolRequestContext) =>
      handleHttpRequest(dependencies, request, context),
    routes: Object.freeze(
      clientProtocols.map((protocol) =>
        Object.freeze({
          method: protocol.method,
          pathname: protocol.pathname,
        }),
      ),
    ),
  });
}
