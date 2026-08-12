import type { FetchFunction, MutableModels } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import { createCommandCodePrivateProvider } from "./commandcode-private/provider.js";
import { createCommandCodeDefaultModel } from "./commandcode-private/model.js";
import {
  createNodeProjectSnapshot,
  type ProjectSnapshot,
} from "./commandcode-private/project.js";

export type { ProjectSnapshot } from "./commandcode-private/project.js";
export type { CommandCodeCompatibilityPolicy } from "./commandcode-private/provider.js";

/**
 * LuckyToken built-in provider catalog.
 *
 * This is the only module that imports concrete Provider implementations.
 * Composition roots and external callers interact with providers exclusively
 * through the Pi `Models` interface and provider id / model id — never through
 * provider implementation code.
 */

export interface LuckyTokenProviderDependencies {
  readonly fetch: FetchFunction;
  readonly now?: () => number;
  readonly projectSnapshot?: ProjectSnapshot;
  readonly createSessionId?: () => string;
  /** Test-only override for the provider upstream endpoint. */
  readonly baseUrl?: string;
}

/**
 * Register every LuckyToken built-in provider into a Pi `Models` collection.
 * Concrete provider dependencies are injected here — the only place that
 * touches provider implementations.
 */
export function registerLuckyTokenProviders(
  models: MutableModels,
  dependencies: LuckyTokenProviderDependencies,
): void {
  const provider = createCommandCodePrivateProvider({
    fetch: dependencies.fetch,
    now: dependencies.now ?? Date.now,
    projectSnapshot: dependencies.projectSnapshot ?? createNodeProjectSnapshot(),
    createSessionId: dependencies.createSessionId ?? randomUUID,
    ...(dependencies.baseUrl === undefined
      ? {}
      : { model: createCommandCodeDefaultModel(dependencies.baseUrl) }),
  });
  models.setProvider(provider);
}
