import type { Models } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";

import type { Auth } from "./auth.js";
import {
  handleHttpRequest,
  type HttpBoundaryDependencies,
} from "./http.js";
import {
  defaultAnthropicModelValidityPolicy,
  type AnthropicModelValidityPolicy,
} from "./protocols/anthropic/representability.js";
import type { RouterOptionDefaults } from "./options.js";

export interface LuckyTokenRuntime {
  handle(request: Request): Promise<Response>;
}

export interface LuckyTokenRuntimeOptions {
  models: Models;
  auth: Auth;
  createMessageId?: () => string;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  shutdownSignal?: AbortSignal;
  routerDefaults?: RouterOptionDefaults;
  anthropicModelValidityPolicy?: AnthropicModelValidityPolicy;
  now?: () => number;
}

export function createLuckyTokenRuntime(
  options: LuckyTokenRuntimeOptions,
): LuckyTokenRuntime {
  const now = options.now ?? Date.now;
  const validityPolicySource =
    options.anthropicModelValidityPolicy ?? defaultAnthropicModelValidityPolicy;
  const classifyFinalAssistantPrefill =
    validityPolicySource.classifyFinalAssistantPrefill;
  const hasCertifiedImageFidelity =
    validityPolicySource.hasCertifiedImageFidelity;
  const modelValidityPolicySnapshot: AnthropicModelValidityPolicy = {
    revision: validityPolicySource.revision,
    classifyFinalAssistantPrefill: (model, profile) =>
      classifyFinalAssistantPrefill(model, profile),
    hasCertifiedImageFidelity: (model) => hasCertifiedImageFidelity(model),
  };
  const modelValidityPolicy = Object.freeze(modelValidityPolicySnapshot);
  const createMessageId = options.createMessageId ?? (() => `msg_${randomUUID()}`);
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const requestTimeoutMs = options.requestTimeoutMs;
  const shutdownSignal = options.shutdownSignal;
  const routerDefaults = options.routerDefaults ?? {};

  const dependencies: HttpBoundaryDependencies = {
    models: options.models,
    auth: options.auth,
    modelValidityPolicy,
    createMessageId,
    maxRequestBytes,
    requestTimeoutMs,
    shutdownSignal,
    routerDefaults: Object.freeze({ ...routerDefaults }),
    now,
  };

  const runtime: LuckyTokenRuntime = {
    handle: (request) => handleHttpRequest(dependencies, request),
  };
  return Object.freeze(runtime);
}
