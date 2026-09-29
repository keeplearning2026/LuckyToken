/**
 * Online probe: does a provider-side model keep the Responses `namespace` field
 * on a namespaced `function_call` across a multi-turn conversation, and does a
 * corrective instruction change that?
 *
 * Motivation: this repository's diagnostics show `mimo-v2.6-flash` calling
 * declared namespace children (`multi_agent_v1.spawn_agent`) sometimes with and
 * sometimes without `namespace`. A Codex caller resolves a missing `namespace`
 * under the default namespace `functions`, fails the registry lookup, and
 * answers `unsupported call: spawn_agent`.
 *
 * The probe runs whole conversations. Each turn asks for a sub-agent, feeds the
 * resulting call and its output back as history, and records the namespace the
 * model emitted both in the raw upstream stream and in the client-facing stream.
 * Both arms share tools, history shape, and user turns; only `instructions`
 * differs.
 *
 * Usage:
 *   node scripts/run-with-codex-test-sandbox.mjs -- npx tsx \
 *     test/online/run-responses-namespace-probe.ts \
 *     --model commandcode-goat/xiaomi/mimo-v2.6-flash \
 *     --conversations 2 --turns 4
 *
 * Use the caller's recorded instructions and tool catalog instead of the small
 * synthetic ones (a long Codex prompt and a 255 KB tool catalog):
 *   ... --replay <client-request-wire.json> --instructions recorded --tools recorded
 */
import { readFile } from "node:fs/promises";

import { createResponsesSmokeHarness } from "./responses-smoke-harness.js";

const DEFAULT_MODEL = "commandcode-goat/xiaomi/mimo-v2.6-flash";
const DEFAULT_CONVERSATIONS = 1;
const DEFAULT_TURNS = 4;
const API_KEY_FILE = "CommandcodeAPIKey.txt";

const BASE_INSTRUCTIONS = [
  "You are a coding agent that can call the tools declared by the caller.",
  "When the user asks you to use a tool, call it instead of describing it.",
].join("\n");

const NAMESPACE_CORRECTION = [
  "Function-call namespace rule (mandatory):",
  "Some tools are declared inside a namespace, for example",
  '{"type":"namespace","name":"multi_agent_v1","tools":[{"type":"function","name":"spawn_agent",...}]}.',
  "When you call a tool declared that way, the call MUST carry all of these fields:",
  '- "name": the child tool name exactly as declared, for example "spawn_agent".',
  '- "namespace": the enclosing namespace name exactly as declared, for example "multi_agent_v1".',
  '- "arguments": the JSON argument object serialized as a string.',
  'Never omit "namespace", and never fold the namespace into "name" (do not send',
  '"multi_agent_v1__spawn_agent" or "multi_agent_v1.spawn_agent").',
  'A call sent as {"name":"spawn_agent"} without "namespace" is resolved under the default',
  'namespace "functions", the tool is not found, and the caller fails with',
  '"unsupported call: spawn_agent".',
].join("\n");

const FORMAT_RULE = [
  "OUTPUT FORMAT for tool calls (overrides any habit):",
  'Emit {"type":"function_call","name":"<child>","namespace":"<namespace>","arguments":"<json>"}.',
  'For the declared namespace "multi_agent_v1" the child call is',
  '{"type":"function_call","name":"spawn_agent","namespace":"multi_agent_v1","arguments":"{\\"message\\":\\"...\\"}"}.',
  '"namespace" is a required sibling of "name" on every call, in every turn, including',
  "repeated calls to a tool you already used earlier in this conversation.",
].join("\n");

const SYNTHETIC_TOOLS = [
  {
    type: "namespace",
    name: "multi_agent_v1",
    description: "Tools for spawning and managing sub-agents.",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        description:
          "Spawn a sub-agent that shares the workspace and works on a task.",
        strict: false,
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Task for the sub-agent." },
          },
          required: ["message"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "wait_agent",
        description: "Wait for a sub-agent to finish.",
        strict: false,
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "Agent id to wait for." },
          },
          required: ["target"],
          additionalProperties: false,
        },
      },
    ],
  },
];

interface ObservedCall {
  readonly item: Readonly<Record<string, unknown>>;
  readonly name: string;
  readonly callId: string;
  readonly namespace: string | undefined;
}

interface TurnObservation {
  readonly turn: number;
  readonly clientNamespace: string | undefined;
  readonly upstreamNamespace: string | undefined;
  readonly name: string | undefined;
  readonly upstreamName: string | undefined;
  readonly upstreamItem: string | undefined;
  readonly note?: string;
}

interface ArmReport {
  readonly arm: string;
  readonly instructionChars: number;
  readonly userSuffixChars: number;
  readonly withNamespace: number;
  readonly withoutNamespace: number;
  readonly noCall: number;
  readonly sequences: readonly string[];
  readonly turns: readonly TurnObservation[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function observeCalls(body: string): readonly ObservedCall[] {
  const calls: ObservedCall[] = [];
  const record = (item: unknown): void => {
    if (!isRecord(item) || item.type !== "function_call") return;
    if (typeof item.name !== "string") return;
    calls.push({
      item,
      name: item.name,
      callId: typeof item.call_id === "string" ? item.call_id : "",
      namespace: typeof item.namespace === "string" ? item.namespace : undefined,
    });
  };

  if (body.trimStart().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return calls;
    }
    if (isRecord(parsed) && Array.isArray(parsed.output)) {
      for (const item of parsed.output) record(item);
    }
    return calls;
  }

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "response.output_item.done") {
      continue;
    }
    record(parsed.item);
  }
  return calls;
}

function optionValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function userItem(text: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
}

function outputItem(
  call: ObservedCall,
  turn: number,
): Readonly<Record<string, unknown>> {
  const namespacePresent = call.namespace !== undefined;
  const output = namespacePresent
    ? JSON.stringify({
        agent_id: `01a0probe-0000-7000-8000-0000000000${turn}`,
        nickname: "probe",
      })
    : `unsupported call: ${call.name}`;
  return Object.freeze({
    type: "function_call_output",
    call_id: call.callId,
    output,
  });
}

/**
 * Records raw upstream responses without disturbing streaming: the clone is read
 * in the background while the original response keeps flowing to its consumer.
 */
function installUpstreamRecorder(): {
  readonly captures: { readonly url: string; status: number; body: string }[];
  readonly pending: Promise<void>[];
  readonly restore: () => void;
} {
  const original = globalThis.fetch;
  const captures: { url: string; status: number; body: string }[] = [];
  const pending: Promise<void>[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await original(request);
    const host = new URL(request.url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") {
      const capture = { url: request.url, status: response.status, body: "" };
      captures.push(capture);
      pending.push(
        response
          .clone()
          .text()
          .then(
            (body) => {
              capture.body = body;
            },
            () => undefined,
          ),
      );
    }
    return response;
  };
  return {
    captures,
    pending,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function run(): Promise<void> {
  const model = optionValue("--model") ?? DEFAULT_MODEL;
  const conversations = positiveInteger(
    optionValue("--conversations"),
    DEFAULT_CONVERSATIONS,
  );
  const turns = positiveInteger(optionValue("--turns"), DEFAULT_TURNS);
  const replayPath = optionValue("--replay");
  const instructionsSource =
    optionValue("--instructions") ?? (replayPath === undefined ? "synthetic" : "recorded");
  const toolsSource =
    optionValue("--tools") ?? (replayPath === undefined ? "synthetic" : "recorded");
  const armsFilter = optionValue("--arms") ?? "all";

  let recorded: Readonly<Record<string, unknown>> | undefined;
  if (replayPath !== undefined) {
    const parsed: unknown = JSON.parse(await readFile(replayPath, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error(`Replay body must be a JSON object: ${replayPath}`);
    }
    recorded = parsed;
  }
  const baseInstructions =
    instructionsSource === "recorded" && typeof recorded?.instructions === "string"
      ? recorded.instructions
      : BASE_INSTRUCTIONS;
  const tools =
    toolsSource === "recorded" && recorded?.tools !== undefined
      ? recorded.tools
      : SYNTHETIC_TOOLS;

  const recorder = installUpstreamRecorder();
  const harness = await createResponsesSmokeHarness({
    providerId: "commandcode-goat",
    model,
    apiKeyFile: API_KEY_FILE,
  });
  const arms = [
    Object.freeze({
      id: "baseline",
      instructions: baseInstructions,
      userSuffix: "",
    }),
    Object.freeze({
      id: "rule-instructions",
      instructions: `${baseInstructions}\n${NAMESPACE_CORRECTION}`,
      userSuffix: "",
    }),
    Object.freeze({
      id: "rule-turn",
      instructions: baseInstructions,
      userSuffix: `\n\n${NAMESPACE_CORRECTION}`,
    }),
    Object.freeze({
      id: "format-instructions",
      instructions: `${baseInstructions}\n${FORMAT_RULE}`,
      userSuffix: "",
    }),
    Object.freeze({
      id: "format-turn",
      instructions: baseInstructions,
      userSuffix: `\n\n${FORMAT_RULE}`,
    }),
  ].filter(
    (arm) =>
      armsFilter === "all" ||
      armsFilter.split(",").map((id) => id.trim()).includes(arm.id),
  );
  const observations = new Map<string, TurnObservation[]>(
    arms.map((arm) => [arm.id, []]),
  );
  const sequences = new Map<string, string[]>(
    arms.map((arm) => [arm.id, []]),
  );

  try {
    for (let conversation = 1; conversation <= conversations; conversation += 1) {
      for (const arm of arms) {
        const input: unknown[] = [];
        let stopped = false;
        for (let turn = 1; turn <= turns && !stopped; turn += 1) {
          const left = 300 + conversation * 10 + turn;
          const right = 400 + conversation * 10 + turn;
          input.push(
            userItem(
              `启动subagent计算 ${left} × ${right}，只返回乘法表达式和十进制结果。` +
                arm.userSuffix,
            ),
          );
          const seen = recorder.captures.length;
          const response = await harness.post({
            model: harness.selector,
            instructions: arm.instructions,
            input,
            tools,
            tool_choice: "auto",
            parallel_tool_calls: true,
            stream: true,
            store: false,
          });
          await Promise.allSettled(recorder.pending);
          const clientCalls = observeCalls(response.text);
          const call = clientCalls.find((candidate) =>
            candidate.name.includes("spawn_agent"),
          );
          const upstreamBodies = recorder.captures
            .slice(seen)
            .filter((capture) => capture.status === 200 && capture.body.length > 0)
            .map((capture) => capture.body);
          const upstreamCall = upstreamBodies
            .flatMap((body) => observeCalls(body))
            .find((candidate) => candidate.name.includes("spawn_agent"));
          const upstreamItem =
            upstreamCall === undefined
              ? undefined
              : JSON.stringify(upstreamCall.item).slice(0, 320);
          const observation: TurnObservation = Object.freeze({
            turn,
            clientNamespace: call?.namespace,
            upstreamNamespace: upstreamCall?.namespace,
            name: call?.name ?? upstreamCall?.name,
            upstreamName: upstreamCall?.name,
            upstreamItem,
            ...(call === undefined
              ? {
                  note:
                    `http ${response.status}; ` +
                    `upstream statuses ` +
                    recorder.captures.slice(seen).map((c) => c.status).join(",") +
                    "; " +
                    response.text.slice(0, 160).replace(/\s+/gu, " "),
                }
              : {}),
          });
          observations.get(arm.id)?.push(observation);
          if (call === undefined) {
            sequences.get(arm.id)?.push("no-call");
            stopped = true;
            continue;
          }
          sequences
            .get(arm.id)
            ?.push(call.namespace === undefined ? "MISSING" : "ns");
          input.push(call.item);
          input.push(outputItem(call, turn));
        }
      }
    }

    const report: readonly ArmReport[] = arms.map((arm) => {
      const trialsForArm = observations.get(arm.id) ?? [];
      const withNamespace = trialsForArm.filter(
        (trial) => trial.clientNamespace !== undefined,
      );
      const noCall = trialsForArm.filter((trial) => trial.name === undefined);
      return Object.freeze({
        arm: arm.id,
        instructionChars: arm.instructions.length,
        userSuffixChars: arm.userSuffix.length,
        withNamespace: withNamespace.length,
        withoutNamespace:
          trialsForArm.length - withNamespace.length - noCall.length,
        noCall: noCall.length,
        sequences: sequences.get(arm.id) ?? [],
        turns: trialsForArm,
      });
    });

    const upstreamNamespaceMismatch = report.some((arm) =>
      arm.turns.some(
        (turn) => turn.clientNamespace !== turn.upstreamNamespace,
      ),
    );
    process.stdout.write(`${JSON.stringify({
      status: report.every((arm) => arm.noCall === 0) ? "observed" : "incomplete",
      provider: "commandcode-goat",
      model: harness.selector,
      providerApi: harness.providerApi,
      upstreamModelId: harness.upstreamModelId,
      lane: "provider-native",
      namespaceToolDeclaredUpstream: harness.exchanges.some((exchange) =>
        exchange.body.includes('"type":"namespace"'),
      ),
      instructionSource: instructionsSource,
      toolsSource,
      conversations,
      turnsPerConversation: turns,
      clientDiffersFromUpstream: upstreamNamespaceMismatch,
      arms: report,
    }, null, 2)}\n`);
  } finally {
    await harness.close();
    recorder.restore();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `Responses namespace probe failed\n${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
