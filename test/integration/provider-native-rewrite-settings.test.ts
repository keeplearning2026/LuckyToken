import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import { createConfiguredTokenDataPlane, type ConfiguredTokenDataPlane } from "../../src/composition.js";
import type { PublicModelSource } from "../../src/public-model-seam.js";
import { createSettingsRegistry, type SettingsRegistry } from "../../src/settings/catalog.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";

const keys = {
  adjacency: "protocols.openai-responses.requestRepair.toolCallAdjacency.providerNative",
  lifecycle: "protocols.openai-responses.responseRepair.sseLifecycle.providerNative",
  namespace: "protocols.openai-responses.responseRepair.functionCallNamespace.providerNative",
} as const;
type Repairs = Readonly<Record<keyof typeof keys, boolean>>;
const alias = "public/native";
const model: Model<string> = {
  id: "native-model", name: "native-model", provider: "openai", api: "openai-responses",
  baseUrl: "https://responses.example.com", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
};
const input = [
  { type: "function_call", call_id: "a", name: "lookup", arguments: "{}" },
  { type: "function_call", call_id: "b", name: "lookup", arguments: "{}" },
  { type: "function_call_output", call_id: "a", output: "A" },
  { type: "message", role: "developer", content: [{ type: "input_text", text: "resize notice" }] },
  { type: "function_call_output", call_id: "b", output: "B" },
];
const clientBody = {
  model: alias, input, stream: true, reasoning: { effort: "ultra" }, future_control: { opaque: true },
  tools: [{ type: "namespace", name: "dynamic_tools", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] }],
};
const item = (id: string, status: string) => ({ type: "function_call", id, call_id: id, name: "lookup", arguments: "{}", status });
const events = [
  { type: "response.created", response: { id: "resp_native", model: model.id, status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: item("fc_a", "in_progress") },
  { type: "response.output_item.added", output_index: 1, item: item("fc_b", "in_progress") },
  { type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_b", delta: "{}" },
  { type: "response.output_item.done", output_index: 1, item: item("fc_b", "completed") },
  { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_a", delta: "{}" },
  { type: "response.output_item.done", output_index: 0, item: item("fc_a", "completed") },
  { type: "response.completed", response: { id: "resp_native", model: model.id, status: "completed", output: [item("fc_b", "completed"), item("fc_a", "completed")] } },
];
const upstreamBody = events.map((event, sequence_number) =>
  `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
).join("") + "data: [DONE]\n\n";

function request(): Request {
  return new Request("http://Token.test/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(clientBody),
  });
}

async function setRepairs(registry: SettingsRegistry, repairs: Repairs): Promise<void> {
  for (const name of Object.keys(keys) as Array<keyof typeof keys>) {
    expect((await registry.set(keys[name], repairs[name], undefined)).outcome).toBe("applied");
  }
}

async function withServing(
  repairs: Repairs,
  run: (composition: ConfiguredTokenDataPlane, registry: SettingsRegistry, forwarded: Record<string, unknown>[]) => Promise<void>,
  duringFetch?: (registry: SettingsRegistry) => Promise<void>,
  readSetting: (registry: SettingsRegistry, key: string) => boolean = (registry, key) => registry.query([key])[key]?.value !== false,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "Token-native-rewrites-"));
  let composition: ConfiguredTokenDataPlane | undefined;
  try {
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: "token-config-v2", server: { port: 0 },
      clientProtocols: { "anthropic-messages": {}, "openai-responses": {} },
      providerPackages: {}, pi: { directory: "pi" },
    }));
    const registry = createSettingsRegistry({ load: async () => ({}), save: async () => undefined });
    await registry.load();
    await setRepairs(registry, repairs);
    const forwarded: Record<string, unknown>[] = [];
    const fetch: FetchFunction = async (url, init) => {
      forwarded.push(JSON.parse(await new Request(url, init).text()) as Record<string, unknown>);
      await duringFetch?.(registry);
      return new Response(upstreamBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const source = { getProviders: () => [model.provider], getModels: () => [model], getAuth: async () => ({ auth: { apiKey: "sk-test" } }) } as unknown as Models;
    const publicModels: PublicModelSource = {
      requestSnapshot: async () => ({ resolve: (selector: string) => selector === alias ? { providerId: model.provider, modelId: model.id } : undefined }) as never,
    };
    const read = (key: string) => () => readSetting(registry, key);
    const unavailableProfileOperation = async (): Promise<never> => { throw new Error("This fixture uses unbound Native auth only"); };
    composition = await createConfiguredTokenDataPlane({
      configuration: await loadTokenCliConfig(configPath), models: source,
      providerAuthBindings: { ...ambientProfileBindings, captureProfile: unavailableProfileOperation, createAcquisitionBinding: unavailableProfileOperation, publishIfCurrent: unavailableProfileOperation },
      publicModels, isProtocolEnabled: () => true, fetch,
      toolCallAdjacency: read(keys.adjacency), sseLifecycleNormalization: read(keys.lifecycle),
      functionCallNamespaceRepair: read(keys.namespace),
    });
    await run(composition, registry, forwarded);
  } finally {
    await composition?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function assertResult(body: string, forwarded: Record<string, unknown>, repairs: Repairs): void {
  expect(forwarded).toEqual({ ...clientBody, model: model.id, input: repairs.adjacency ? [input[0], input[1], input[2], input[4], input[3]] : input });
  const frames = body.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  const added = frames.filter((event) => event.type === "response.output_item.added");
  const done = frames.filter((event) => event.type === "response.output_item.done");
  expect(added.map((event) => event.output_index)).toEqual(repairs.lifecycle ? [1, 0] : [0, 1]);
  expect(done.map((event) => event.output_index)).toEqual([1, 0]);
  expect(frames.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  for (const event of [...added, ...done]) {
    expect((event.item as Record<string, unknown>).namespace).toBe(repairs.namespace ? "dynamic_tools" : undefined);
  }
  const completed = frames.at(-1)?.response as { model: string; output: Record<string, unknown>[] };
  expect(completed.model).toBe(alias);
  expect(completed.output.map((entry) => entry.namespace)).toEqual(repairs.namespace ? ["dynamic_tools", "dynamic_tools"] : [undefined, undefined]);
  if (!repairs.lifecycle && !repairs.namespace) expect(body).toBe(upstreamBody.replaceAll(model.id, alias));
}

describe("Provider Native rewrite settings through production composition", () => {
  const combinations = [false, true].flatMap((adjacency) => [false, true].flatMap((lifecycle) => [false, true].map((namespace) => ({ adjacency, lifecycle, namespace }))));

  it.each(combinations)("keeps independent stages: adjacency=$adjacency lifecycle=$lifecycle namespace=$namespace", async (repairs) => {
    await withServing(repairs, async (composition, _registry, forwarded) => {
      const response = await composition.runtime.handle(request());
      expect(response.status).toBe(200);
      expect(forwarded).toHaveLength(1);
      assertResult(await response.text(), forwarded[0]!, repairs);
    });
  });

  it("hot-applies settings to the next request while retaining the current request snapshot", async () => {
    const on = { adjacency: true, lifecycle: true, namespace: true };
    const off = { adjacency: false, lifecycle: false, namespace: false };
    await withServing(on, async (composition, _registry, forwarded) => {
      const first = await composition.runtime.handle(request());
      expect(first.status).toBe(200);
      assertResult(await first.text(), forwarded[0]!, on);
      const second = await composition.runtime.handle(request());
      expect(second.status).toBe(200);
      assertResult(await second.text(), forwarded[1]!, off);
    }, (registry) => setRepairs(registry, off));
  });

  it.each(["adjacency", "lifecycle", "namespace"] as const)("contains a %s setting read failure without affecting the other stages", async (failed) => {
    await withServing({ adjacency: true, lifecycle: true, namespace: true }, async (composition, _registry, forwarded) => {
      const response = await composition.runtime.handle(request());
      expect(response.status).toBe(200);
      assertResult(await response.text(), forwarded[0]!, { adjacency: true, lifecycle: true, namespace: true, [failed]: false });
    }, undefined, (registry, key) => {
      if (key === keys[failed]) throw new Error("settings unavailable");
      return registry.query([key])[key]?.value !== false;
    });
  });
});
