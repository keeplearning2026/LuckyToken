import type { LuckyTokenRuntime } from "../runtime.js";
export interface RegisteredProtocolRoute {
  readonly id: string;
  readonly method: string;
  readonly pathname: string;
}

export interface ProtocolAwareRuntimeOptions {
  readonly runtime: LuckyTokenRuntime;
  readonly isProtocolEnabled: (protocolId: string) => boolean;
  readonly protocolRoutes: readonly RegisteredProtocolRoute[];
}

/**
 * Settings-aware runtime: each registered Client Protocol route is served
 * only while its registered `protocols.<id>.enabled` setting is true. The
 * route table (method + pathname) remains stable; disabling a protocol makes
 * its route unreachable with 404 while the Control Plane stays available.
 */
export function createProtocolAwareRuntime(
  options: ProtocolAwareRuntimeOptions,
): LuckyTokenRuntime {
  const protocolRoutes = Object.freeze([...options.protocolRoutes]);
  return Object.freeze({
    ...options.runtime,
    handle: async (request: Request): Promise<Response> => {
      const pathname = new URL(request.url).pathname;
      const route = protocolRoutes.find(
        (candidate) =>
          candidate.method === request.method &&
          candidate.pathname === pathname,
      );
      if (route !== undefined) {
        if (!options.isProtocolEnabled(route.id)) {
          return new Response(null, { status: 404 });
        }
      }
      return options.runtime.handle(request);
    },
  });
}
