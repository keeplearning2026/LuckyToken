import type { Models } from "@earendil-works/pi-ai";
import { writeFile } from "node:fs/promises";

import {
  createPublicModelAuthority,
  type PublicModelAuthority,
  type PublicModelEndpoint,
} from "../../src/public-models/authority.js";

export async function createOnlinePublicModelAuthority(input: {
  readonly path: string;
  readonly endpoint: PublicModelEndpoint;
  readonly alias: string;
  readonly providerId: string;
  readonly modelId: string;
}): Promise<PublicModelAuthority> {
  await writeFile(
    input.path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        endpoint: input.endpoint,
        providers: {
          [input.providerId]: {
            enabled: true,
            models: {
              [input.alias]: {
                target: input.modelId,
                enabled: true,
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return createPublicModelAuthority({
    path: input.path,
    initialEndpoint: input.endpoint,
  });
}

export async function reconcileOnlinePublicModels(
  authority: PublicModelAuthority,
  models: Pick<Models, "getModels">,
  loggedInProviderId: string,
): Promise<void> {
  const byProvider = new Map<string, string[]>();
  for (const model of models.getModels()) {
    const ids = byProvider.get(model.provider) ?? [];
    ids.push(model.id);
    byProvider.set(model.provider, ids);
  }
  await authority.reconcile({
    version: 1,
    providers: Object.freeze(
      [...byProvider].map(([providerId, modelIds]) =>
        Object.freeze({
          providerId,
          usable: providerId === loggedInProviderId,
          models: Object.freeze(modelIds),
        }),
      ),
    ),
  });
}
