import type {
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import {
  assertLuckyTokenProviderPackage,
  type ProviderHostCapabilities,
} from "@luckytoken/provider-contract/package";
import { isBuiltin } from "node:module";

import { isSafeProviderId } from "./provider-id.js";

export type ImportProviderModule = (specifier: string) => Promise<unknown>;

export interface LoadProviderPackagesOptions {
  readonly models: MutableModels;
  readonly providerPackages: Readonly<Record<string, unknown>>;
  readonly host: ProviderHostCapabilities;
  readonly importModule?: ImportProviderModule;
}

export interface LoadedProviderPackages {
  readonly providerIds: readonly string[];
}

const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const SCOPED_PACKAGE_NAME =
  /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u;

export function assertProviderPackageSpecifier(specifier: string): void {
  if (
    (!PACKAGE_NAME.test(specifier) && !SCOPED_PACKAGE_NAME.test(specifier)) ||
    isBuiltin(specifier)
  ) {
    throw new Error(
      `Provider Package specifier must be an npm root package name: ${specifier}`,
    );
  }
}

function configurationPath(specifier: string): string {
  return `providerPackages[${JSON.stringify(specifier)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertProvider(value: unknown, path: string): asserts value is Provider {
  if (!isRecord(value)) {
    throw new TypeError(`${path}.createProvider() must return a Pi Provider`);
  }
  if (typeof value.id !== "string" || !isSafeProviderId(value.id)) {
    throw new TypeError(
      `${path}.createProvider().id must be a safe Provider ID of 1-64 characters`,
    );
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new TypeError(`${path}.createProvider().name must be non-empty`);
  }
  if (!isRecord(value.auth)) {
    throw new TypeError(`${path}.createProvider().auth must be defined`);
  }
  for (const method of ["getModels", "stream", "streamSimple"] as const) {
    if (typeof value[method] !== "function") {
      throw new TypeError(`${path}.createProvider().${method} must be a function`);
    }
  }
  const provider = value as unknown as Provider;
  if (!Array.isArray(provider.getModels())) {
    throw new TypeError(`${path}.createProvider().getModels() must return an array`);
  }
}

async function importProviderModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadProviderPackages(
  options: LoadProviderPackagesOptions,
): Promise<LoadedProviderPackages> {
  const importModule = options.importModule ?? importProviderModule;
  const existingIds = new Set(
    options.models.getProviders().map((provider) => provider.id),
  );
  const staged: Provider[] = [];
  const stagedIds = new Set<string>();

  for (const [specifier, configuration] of Object.entries(
    options.providerPackages,
  )) {
    assertProviderPackageSpecifier(specifier);
    const path = configurationPath(specifier);
    try {
      const namespace = await importModule(specifier);
      if (!isRecord(namespace) || !("providerPackage" in namespace)) {
        throw new TypeError(`${path} module must export providerPackage`);
      }
      const providerPackage = assertLuckyTokenProviderPackage(
        namespace.providerPackage,
      );
      const provider = await Promise.resolve(
        providerPackage.createProvider({
          configuration,
          configurationPath: path,
          host: options.host,
        }),
      );
      assertProvider(provider, path);
      if (existingIds.has(provider.id) || stagedIds.has(provider.id)) {
        throw new Error(
          `${path} Provider ID conflicts with an already registered Provider: ${provider.id}`,
        );
      }
      staged.push(provider);
      stagedIds.add(provider.id);
    } catch (error) {
      throw new Error(
        `Failed to load Provider Package ${specifier}: ${errorMessage(error)}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  for (const provider of staged) options.models.setProvider(provider);
  return Object.freeze({ providerIds: Object.freeze([...stagedIds]) });
}
