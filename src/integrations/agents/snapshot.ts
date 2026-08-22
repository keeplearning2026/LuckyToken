import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";

import type {
  PublicModelSnapshot,
  PublishedPublicModel,
} from "../../public-models/authority.js";

export interface AgentInjectionModel {
  readonly alias: string;
  readonly target: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly reasoning: boolean;
  readonly thinkingLevels: readonly string[];
  readonly input: readonly ("text" | "image")[];
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly tiers?: readonly {
      readonly inputTokensAbove: number;
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
    }[];
  };
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface AgentInjectionSnapshot {
  readonly endpoint: {
    readonly origin: string;
    readonly openaiBaseUrl: string;
  };
  readonly full: readonly AgentInjectionModel[];
  readonly favorite: readonly AgentInjectionModel[];
  readonly warnings: readonly string[];
}

export interface CreateAgentInjectionSnapshotOptions {
  readonly publicModels: PublicModelSnapshot;
  readonly models: Pick<Models, "getModels">;
}

function dialHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "localhost"
  ) {
    return "127.0.0.1";
  }
  if (normalized === "::1" || normalized === "[::1]") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function targetKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function project(
  entries: readonly PublishedPublicModel[],
  callable: ReadonlyMap<string, Model<Api>>,
  warnings: string[],
): readonly AgentInjectionModel[] {
  return Object.freeze(
    [...entries]
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .flatMap((entry) => {
        const model = callable.get(targetKey(entry.providerId, entry.modelId));
        if (model === undefined) {
          warnings.push(
            `Alias "${entry.alias}" is not injectable because its target model no longer exists.`,
          );
          return [];
        }
        return [
          Object.freeze({
            alias: entry.alias,
            target: Object.freeze({
              providerId: entry.providerId,
              modelId: entry.modelId,
            }),
            reasoning: model.reasoning,
            thinkingLevels: Object.freeze([...getSupportedThinkingLevels(model)]),
            input: Object.freeze([...model.input]),
            cost: Object.freeze({
              ...model.cost,
              ...(model.cost.tiers === undefined
                ? {}
                : {
                    tiers: Object.freeze(
                      model.cost.tiers.map((tier) => Object.freeze({ ...tier })),
                    ),
                  }),
            }),
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          }),
        ];
      }),
  );
}

export function createAgentInjectionSnapshot(
  options: CreateAgentInjectionSnapshotOptions,
): AgentInjectionSnapshot {
  const callable = new Map(
    options.models
      .getModels()
      .map((model) => [targetKey(model.provider, model.id), model] as const),
  );
  const warnings: string[] = [];
  const host = dialHost(options.publicModels.endpoint.host);
  const origin = `http://${host}:${options.publicModels.endpoint.port}`;
  return Object.freeze({
    endpoint: Object.freeze({ origin, openaiBaseUrl: `${origin}/v1` }),
    full: project(options.publicModels.publishedModels(), callable, warnings),
    favorite: project(options.publicModels.favoriteModels(), callable, warnings),
    warnings: Object.freeze(warnings),
  });
}
