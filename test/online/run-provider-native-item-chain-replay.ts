import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FetchFunction, Model, Models } from "@earendil-works/pi-ai";

import type { ClientProtocolHandler } from "../../src/http.js";
import { createProviderNativeResponses } from "../../src/provider-native-responses/index.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";
import { createTokenRuntime } from "../../src/runtime.js";
import { startTokenHttpServer } from "../../src/server.js";
import { ambientProfileBindings } from "../support/profile-binding-fixture.js";
import { replayCodexPatchConsumers } from "../support/codex-patch-consumer-replay.js";

const FORBIDDEN = [
  "OutputTextDelta without active item",
  "ReasoningSummaryDelta without active item",
  "ReasoningSummaryPartAdded without active item",
  "ReasoningRawContentDelta without active item",
] as const;

const root = await mkdtemp(join(tmpdir(), "Token-production-item-chain-replay-"));
const cli = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js",
);

const message = (id: string, text = "", status = "completed") => ({
  type: "message",
  id,
  role: "assistant",
  status,
  content: text ? [{ type: "output_text", text, annotations: [] }] : [],
});
const reasoning = (id: string, status = "completed", summaryText = "") => ({
  type: "reasoning",
  id,
  status,
  summary: summaryText ? [{ type: "summary_text", text: summaryText }] : [],
});
const a = message("msg_a", "ANSWER_A");
const b = message("msg_b", "ANSWER_B");
const added = (item: ReturnType<typeof message>, index: number) => ({
  type: "response.output_item.added",
  output_index: index,
  item: message(item.id, "", "in_progress"),
});
const delta = (
  item: ReturnType<typeof message>,
  index: number,
  text: string,
) => ({
  type: "response.output_text.delta",
  output_index: index,
  item_id: item.id,
  content_index: 0,
  delta: text,
});
const done = (item: ReturnType<typeof message>, index: number) => ({
  type: "response.output_item.done",
  output_index: index,
  item,
});
const chainA = [added(a, 0), delta(a, 0, "ANSWER_A"), done(a, 0)] as const;
const chainB = [added(b, 1), delta(b, 1, "ANSWER_B"), done(b, 1)] as const;
const terminalFor = (output: readonly Record<string, unknown>[]) => ({
  type: "response.completed",
  response: {
    id: "resp_replay",
    object: "response",
    status: "completed",
    model: "gpt-native",
    output,
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  },
});

let wire = "";
let providerRequests = 0;
let providerResponder: ((request: Request) => Promise<Response>) | undefined;

const outboundProviderBodies: string[] = [];

/** Independent adjacency oracle: mirrors the upstream Chat contraction rule
 * without calling any Token projection code. */
function violatesToolCallAdjacency(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const input = (parsed as Record<string, unknown>).input;
  if (!Array.isArray(input)) return false;
  const pending = new Set<string>();
  let sawOutput = false;
  for (const entry of input) {
    const item = entry as Record<string, unknown>;
    const type = item?.type;
    const callId = item?.call_id;
    if (type === "function_call" || type === "custom_tool_call") {
      if (pending.size > 0 && sawOutput) return true;
      if (typeof callId === "string") pending.add(callId);
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (pending.size === 0) continue;
      sawOutput = true;
      if (typeof callId === "string") pending.delete(callId);
      if (pending.size === 0) sawOutput = false;
      continue;
    }
    if (pending.size > 0) return true;
  }
  return pending.size > 0;
}

const TOOL_HISTORY_IMAGE_CALL_ID = "call_tool_a";
const TOOL_HISTORY_SIBLING_CALL_ID = "call_tool_b";

function toolHistoryInput(body: string): readonly Record<string, unknown>[] {
  return (JSON.parse(body) as { input: readonly Record<string, unknown>[] }).input;
}

/** The inclusive slice from the image tool output to its sibling tool output. */
function toolHistoryGroupWindow(
  items: readonly Record<string, unknown>[],
): readonly string[] {
  const label = (item: Record<string, unknown>): string => {
    if (item.type === "function_call_output" && typeof item.call_id === "string") {
      return `output:${item.call_id}`;
    }
    if (item.type === "message" && item.role === "developer") return "developer";
    return String(item.type);
  };
  const image = items.findIndex(
    (item) =>
      item.type === "function_call_output" &&
      item.call_id === TOOL_HISTORY_IMAGE_CALL_ID,
  );
  const sibling = items.findIndex(
    (item) =>
      item.type === "function_call_output" &&
      item.call_id === TOOL_HISTORY_SIBLING_CALL_ID,
  );
  assert.ok(image >= 0 && sibling >= 0, "both tool outputs must be in history");
  return items
    .slice(Math.min(image, sibling), Math.max(image, sibling) + 1)
    .map(label);
}

function runCodex(
  args: readonly string[],
  cwd: string,
  codexHome: string,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: "local-production-replay-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), 45_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

let tokenServer: Awaited<ReturnType<typeof startTokenHttpServer>> | undefined;
try {
  const model: Model<string> = {
    id: "gpt-native",
    name: "GPT Native",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://provider.example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const models = {
    getModels: () => [model],
    getAuth: async () => ({ auth: { apiKey: "local-provider-key" } }),
  } as unknown as Models;
  const providerFetch: FetchFunction = async (input, init) => {
    providerRequests += 1;
    const request = new Request(input, init);
    if (providerResponder !== undefined) {
      outboundProviderBodies.push(await request.clone().text());
      return providerResponder(request);
    }
    return new Response(wire, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const handler = createOpenAIResponsesHandler({
    models,
    providerNativeLane: createProviderNativeResponses({
      models,
      bindings: ambientProfileBindings,
      fetch: providerFetch,
    }),
    stateFile: join(root, "responses-state.json"),
    maxRequestBytes: 1_000_000,
    createSessionId: () => "session_replay",
    createResponseId: () => "resp_unused",
    now: () => 1,
  });
  tokenServer = await startTokenHttpServer({
    runtime: createTokenRuntime({ clientProtocols: [handler] }),
    port: 0,
  });

  const versionHome = join(root, "version-home");
  await mkdir(versionHome, { recursive: true });
  const version = await runCodex(["--version"], root, versionHome);
  process.stdout.write(version.stdout.trim() + "\n");

  const cases = [
    {
      name: "overlap_index_ordered_done",
      events: [chainA[0], chainA[1], chainB[0], chainA[2], chainB[1], chainB[2]],
      finalOutput: [a, b],
      expectedFinal: "ANSWER_B",
      expectedMessages: ["ANSWER_A", "ANSWER_B"],
    },
    {
      name: "overlap_reverse_done",
      events: [chainA[0], ...chainB, chainA[1], chainA[2]],
      finalOutput: [a, b],
      expectedFinal: "ANSWER_A",
      expectedMessages: ["ANSWER_B", "ANSWER_A"],
    },
    {
      name: "overlap_global_reverse_done",
      events: [
        chainA[0],
        { type: "response.metadata", marker: "global-between" },
        ...chainB,
        chainA[1],
        chainA[2],
      ],
      finalOutput: [a, b],
      expectedFinal: "ANSWER_A",
      expectedMessages: ["ANSWER_B", "ANSWER_A"],
    },
    {
      name: "reasoning_message_overlap",
      events: [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: reasoning("rs_1", "in_progress"),
        },
        {
          type: "response.reasoning_text.delta",
          output_index: 0,
          item_id: "rs_1",
          content_index: 0,
          delta: "internal",
        },
        chainB[0],
        {
          type: "response.output_item.done",
          output_index: 0,
          item: reasoning("rs_1", "completed", "PLAN_R1"),
        },
        chainB[1],
        chainB[2],
      ],
      finalOutput: [reasoning("rs_1", "completed", "PLAN_R1"), b],
      expectedFinal: "ANSWER_B",
      expectedMessages: ["ANSWER_B"],
    },
  ] as const;

  const selectedCase = process.env.TOKEN_REPLAY_CASE;
  const selectedCases =
    selectedCase === undefined
      ? cases
      : cases.filter((testCase) => testCase.name === selectedCase);
  const runToolHistoryCase =
    selectedCase === undefined || selectedCase === "tool_history_overlap";
  const runPatchConsumerCase =
    selectedCase === undefined || selectedCase === "custom_tool_consumer_overlap";
  if (selectedCases.length === 0 && !runToolHistoryCase && !runPatchConsumerCase) {
    throw new Error(`Unknown TOKEN_REPLAY_CASE: ${selectedCase}`);
  }

  for (const testCase of selectedCases) {
    const directory = join(root, testCase.name);
    const codexHome = join(directory, "codex-home");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model = "openai/gpt-native"',
        'model_provider = "token_replay"',
        "[model_providers.token_replay]",
        'name = "LuckyToken production lifecycle replay"',
        `base_url = "${tokenServer.origin}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
      ].join("\n"),
    );
    const output = join(directory, "final.txt");
    wire = [
      {
        type: "response.created",
        response: {
          id: "resp_replay",
          status: "in_progress",
          model: "gpt-native",
        },
      },
      ...testCase.events,
      terminalFor(testCase.finalOutput),
    ]
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");

    const result = await runCodex(
      [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "-o",
        output,
        "Reply with a short answer. Do not use tools.",
      ],
      directory,
      codexHome,
    );
    const final = await readFile(output, "utf8").catch(() => "");
    const events = result.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as {
            type?: string;
            item?: { type?: string; text?: string };
          };
        } catch {
          return {};
        }
      });
    const completedMessages = events
      .filter(
        (event) =>
          event.type === "item.completed" &&
          event.item?.type === "agent_message",
      )
      .map((event) => event.item?.text ?? "");
    const forbidden = FORBIDDEN.filter((diagnostic) =>
      result.stderr.includes(diagnostic),
    );
    const summary = {
      name: testCase.name,
      exitCode: result.code,
      final: final.trim(),
      completedMessages,
      forbidden,
      completed: events.some((event) => event.type === "turn.completed"),
    };
    process.stdout.write(JSON.stringify(summary) + "\n");

    assert.equal(result.code, 0);
    assert.equal(summary.completed, true);
    assert.equal(summary.final, testCase.expectedFinal);
    assert.deepEqual(summary.completedMessages, [...testCase.expectedMessages]);
    assert.deepEqual(
      events.filter((event) => event.type === "item.completed" && event.item?.type === "reasoning")
        .map((event) => event.item?.text),
      testCase.name === "reasoning_message_overlap" ? ["PLAN_R1"] : [],
    );
    assert.deepEqual(summary.forbidden, []);
  }

  if (runToolHistoryCase) {
    const directory = join(root, "tool_history_overlap");
    const codexHome = join(directory, "codex-home");
    await mkdir(codexHome, { recursive: true });

    // §5.5 client-wire observation seam. Token preserves the client body, so the
    // recorded §1.3 shape has to be captured on the wire before Token defers the
    // notice out of the tool-call group.
    const clientRequests: string[] = [];
    const observingProtocol: ClientProtocolHandler = {
      method: handler.method,
      pathname: handler.pathname,
      handle: async (request, context) => {
        clientRequests.push(await request.clone().text());
        return handler.handle(request, context);
      },
    };
    const clientServer = await startTokenHttpServer({
      runtime: createTokenRuntime({ clientProtocols: [observingProtocol] }),
      port: 0,
    });
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model = "openai/gpt-native"',
        'model_provider = "token_replay"',
        // codex-cli 0.156.1 ships the resize notice behind an under-development
        // feature flag. The recorded incident carries the notice, so the replay
        // enables that client feature instead of inventing the notice text.
        "features.image_resize_notice = true",
        "[model_providers.token_replay]",
        'name = "LuckyToken production lifecycle replay"',
        `base_url = "${clientServer.origin}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
      ].join("\n"),
    );

    const firstCallId = TOOL_HISTORY_IMAGE_CALL_ID;
    const secondCallId = TOOL_HISTORY_SIBLING_CALL_ID;
    const firstItemId = "fc_tool_a";
    const secondItemId = "fc_tool_b";
    // §1.3 records an oversized `view_image` followed by a slower sibling tool, so
    // the resized image result is already in the history when the sibling result is
    // appended and the CLI writes its resize notice between the two outputs.
    const imagePath = fileURLToPath(
      new URL(
        "../../reference/opencodex/devlog/_plan/260830_models_provider_header/evidence/040-after-cap-slot-ko-1280.png",
        import.meta.url,
      ),
    );
    const firstArguments = JSON.stringify({ path: imagePath });
    const secondArguments = JSON.stringify({
      cmd: `Start-Sleep -Milliseconds 1500; Write-Output TOOL_B`,
    });
    const firstCall = {
      type: "function_call",
      id: firstItemId,
      call_id: firstCallId,
      name: "view_image",
      arguments: firstArguments,
      status: "completed",
    };
    const secondCall = {
      type: "function_call",
      id: secondItemId,
      call_id: secondCallId,
      name: "exec_command",
      arguments: secondArguments,
      status: "completed",
    };
    const firstCallOpen = { ...firstCall, arguments: "", status: "in_progress" };
    const secondCallOpen = { ...secondCall, arguments: "", status: "in_progress" };
    const firstResponse = [
      {
        type: "response.created",
        response: {
          id: "resp_tools_1",
          status: "in_progress",
          model: "gpt-native",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: reasoning("rs_tools", "in_progress"),
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 2,
        item_id: "rs_tools",
        summary_index: 0,
        delta: "TOOLS_REASONING",
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: firstCallOpen,
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: secondCallOpen,
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: reasoning("rs_tools", "completed", "TOOLS_REASONING"),
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: firstItemId,
        delta: firstArguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: firstItemId,
        arguments: firstArguments,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: firstCall,
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: secondItemId,
        delta: secondArguments,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 1,
        item_id: secondItemId,
        arguments: secondArguments,
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: secondCall,
      },
      {
        type: "response.completed",
        response: {
          id: "resp_tools_1",
          object: "response",
          status: "completed",
          model: "gpt-native",
          output: [firstCall, secondCall],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      },
    ]
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");

    const finalMessage = message("msg_tool_final", "TOOLS_HISTORY_OK");
    const secondResponse = [
      {
        type: "response.created",
        response: {
          id: "resp_tools_2",
          status: "in_progress",
          model: "gpt-native",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: message("msg_tool_final", "", "in_progress"),
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_tool_final",
        content_index: 0,
        delta: "TOOLS_HISTORY_OK",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: finalMessage,
      },
      terminalFor([finalMessage]),
    ]
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\ndata: ${JSON.stringify({
            ...event,
            sequence_number,
          })}\n\n`,
      )
      .join("");

    let toolStage = 0;
    let capturedSecondInput: Record<string, unknown>[] | undefined;
    const outboundBefore = outboundProviderBodies.length;
    providerResponder = async (request) => {
      const body = await request.text();
      if (toolStage === 0) {
        toolStage = 1;
        return new Response(firstResponse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      capturedSecondInput = (
        JSON.parse(body) as { input: Record<string, unknown>[] }
      ).input;
      toolStage = 2;
      return new Response(secondResponse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    try {
      const output = join(directory, "final.txt");
      const result = await runCodex(
        [
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          // The sibling tool has to really run (and stay slow) so the image result
          // lands first and the history carries a genuine tool result. The isolated
          // CLI command policy rejects every command under approval=never, so this
          // case executes the fixed fixture command without a sandbox: a sleep/echo
          // inside the temporary case directory.
          "--dangerously-bypass-approvals-and-sandbox",
          "-o",
          output,
          "Use both tool calls exactly as supplied by the model, then finish.",
        ],
        directory,
        codexHome,
      );
      const final = await readFile(output, "utf8").catch(() => "");
      const events = result.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as {
              type?: string;
              item?: { type?: string; text?: string };
            };
          } catch {
            return {};
          }
        });
      const forbidden = FORBIDDEN.filter((diagnostic) =>
        result.stderr.includes(diagnostic),
      );
      const summary = {
        name: "tool_history_overlap",
        exitCode: result.code,
        final: final.trim(),
        forbidden,
        completed: events.some((event) => event.type === "turn.completed"),
        toolStage,
      };
      process.stdout.write(JSON.stringify(summary) + "\n");

      assert.equal(result.code, 0);
      assert.equal(summary.completed, true);
      assert.equal(summary.final, "TOOLS_HISTORY_OK");
      assert.equal(toolStage, 2);
      assert.deepEqual(forbidden, []);

      // §5.5 evidence. The real CLI must produce the recorded §1.3 interleave on
      // the wire, and Token must hand the Provider a group-adjacent body that
      // still carries the developer message.
      const clientBody = clientRequests.find((body) =>
        body.includes(TOOL_HISTORY_SIBLING_CALL_ID),
      );
      assert.ok(clientBody, "the tool-history client request must reach Token");
      assert.deepEqual(
        toolHistoryGroupWindow(toolHistoryInput(clientBody)),
        [`output:${firstCallId}`, "developer", `output:${secondCallId}`],
        "codex-cli 0.156.1 must place the resize notice between the two tool outputs",
      );

      assert.ok(capturedSecondInput, "Codex must issue a second Responses request");
      const calls = capturedSecondInput.filter((item) => item.type === "function_call");
      assert.deepEqual(
        calls.map(({ call_id, name, arguments: args }) => ({ call_id, name, args })),
        [
          { call_id: firstCallId, name: "view_image", args: firstArguments },
          { call_id: secondCallId, name: "exec_command", args: secondArguments },
        ],
      );
      const outputs = capturedSecondInput.filter(
        (item) => item.type === "function_call_output",
      );
      process.stdout.write(
        JSON.stringify({
          name: "tool_history_captured_outputs",
          outputs: outputs.map((item) => ({
            call_id: item.call_id,
            kind: Array.isArray(item.output) ? "content-array" : typeof item.output,
          })),
        }) + "\n",
      );
      assert.deepEqual(
        outputs.map((item) => item.call_id),
        [firstCallId, secondCallId],
      );
      const imageOutput = outputs[0]!;
      const siblingOutput = outputs[1]!;
      assert.ok(
        Array.isArray(imageOutput.output) &&
          imageOutput.output.some(
            (part) => (part as Record<string, unknown>).type === "input_image",
          ),
        "the view_image result must carry the resized image into the next round",
      );
      const siblingText =
        typeof siblingOutput.output === "string"
          ? siblingOutput.output
          : JSON.stringify(siblingOutput.output);
      assert.match(siblingText, /TOOL_B/u);
      assert.doesNotMatch(
        siblingText,
        /blocked by policy/u,
        "the sibling tool must really execute instead of being rejected by the command policy",
      );
      for (const [index, outputItem] of outputs.entries()) {
        assert.ok(
          capturedSecondInput.indexOf(outputItem) >
            capturedSecondInput.indexOf(calls[index]!),
          "every tool result must follow its own tool call",
        );
      }
      assert.deepEqual(
        toolHistoryGroupWindow(capturedSecondInput),
        [`output:${firstCallId}`, `output:${secondCallId}`],
        "the Provider request must present the tool-call group without interleaved items",
      );
      const outboundNoticeIndex = capturedSecondInput.findIndex(
        (item) =>
          item.type === "message" &&
          item.role === "developer" &&
          JSON.stringify(item.content).includes("<image_resize_notice>"),
      );
      assert.ok(
        outboundNoticeIndex > capturedSecondInput.indexOf(siblingOutput),
        "the deferred resize notice must stay in history after the closed group",
      );

      const caseOutbound = outboundProviderBodies.slice(outboundBefore);
      assert.ok(
        caseOutbound.length >= 2,
        "the tool history case must send at least two Provider requests",
      );
      assert.deepEqual(
        caseOutbound.map((body) => violatesToolCallAdjacency(body)),
        caseOutbound.map(() => false),
        "every outbound Provider body must keep tool-call groups adjacent",
      );

      const reasoningItems = capturedSecondInput.filter(
        (item) => item.type === "reasoning",
      );
      assert.equal(reasoningItems.length, 1);
      assert.equal(reasoningItems[0]!.id, "rs_tools");
      assert.deepEqual(reasoningItems[0]!.summary, [
        { type: "summary_text", text: "TOOLS_REASONING" },
      ]);
      assert.ok(
        capturedSecondInput.indexOf(reasoningItems[0]!) <
          capturedSecondInput.indexOf(calls[0]!),
      );
      process.stdout.write(
        JSON.stringify({
          name: "tool_history_adjacency_observation",
          providerRequests: caseOutbound.length,
          outboundAdjacent: true,
          naturalInterleaveObserved: true,
          injected: false,
          note: "the real codex-cli 0.156.1 produced the recorded §1.3 interleave and Token deferred the resize notice back out of the group",
        }) + "\n",
      );
    } finally {
      providerResponder = undefined;
      await clientServer.close();
    }
  }

  if (runPatchConsumerCase) {
    for (const mode of ["raw", "normalized"] as const) {
      const directory = join(root, `custom_tool_consumer_${mode}`);
      const codexHome = join(directory, "codex-home");
      await mkdir(codexHome, { recursive: true });
      const catalogPath = join(codexHome, "token-model-catalog.json");
      await writeFile(catalogPath, JSON.stringify({ models: [{
        slug: "openai/gpt-native", display_name: "Native replay",
        description: "Isolated custom apply_patch consumer fixture",
        base_instructions: "Apply the supplied patches.",
        supported_reasoning_levels: [], shell_type: "default",
        visibility: "list", supported_in_api: true, priority: 100,
        support_verbosity: false, truncation_policy: { mode: "tokens", limit: 65536 },
        supports_parallel_tool_calls: true, context_window: 200000,
        experimental_supported_tools: [], apply_patch_tool_type: "freeform",
      }] }));
      const calls = ["a", "b"].map((name) => ({
        type: "custom_tool_call", id: `ct_${name}`, call_id: `patch_${name}`,
        name: "apply_patch", status: "completed",
        input: `*** Begin Patch\n*** Add File: ${name}.txt\n+PATCH_${name.toUpperCase()}\n*** End Patch\n`,
      }));
      const [callA, callB] = calls;
      assert.ok(callA && callB);
      const open = (call: typeof callA, index: number) => ({
        type: "response.output_item.added", output_index: index,
        item: { ...call, input: "", status: "in_progress" },
      });
      const inputDelta = (call: typeof callA, index: number, tail: boolean) => ({
        type: "response.custom_tool_call_input.delta", output_index: index,
        item_id: call.id, call_id: call.call_id,
        delta: tail ? call.input.slice(call.input.indexOf("+PATCH")) : call.input.slice(0, call.input.indexOf("+PATCH")),
      });
      const finish = (call: typeof callA, index: number) => ({
        type: "response.output_item.done", output_index: index, item: call,
      });
      const render = (events: readonly Record<string, unknown>[]) => events.map((event, sequence_number) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
      const firstWire = render([
        open(callA, 0), open(callB, 1),
        inputDelta(callA, 0, false), inputDelta(callB, 1, false),
        inputDelta(callA, 0, true), finish(callA, 0),
        inputDelta(callB, 1, true), finish(callB, 1), terminalFor(calls),
      ]);
      const final = message("patch_final", "PATCH_CONSUMERS_OK");
      let stage = 0;
      providerResponder = async (request) => {
        const body = await request.json() as { input: Record<string, unknown>[]; tools: Record<string, unknown>[] };
        if (stage++ === 0) {
          assert.ok(body.tools.some((tool) => tool.type === "custom" && tool.name === "apply_patch"),
            "Codex must register the real freeform apply_patch tool");
          return new Response(firstWire, { headers: { "content-type": "text/event-stream" } });
        }
        assert.deepEqual(body.input.filter((item) => item.type === "custom_tool_call")
          .map(({ call_id, name, input }) => ({ call_id, name, input })),
        calls.map(({ call_id, name, input }) => ({ call_id, name, input })));
        const outputs = body.input.filter((item) => item.type === "custom_tool_call_output");
        assert.deepEqual(outputs.map((item) => item.call_id), ["patch_a", "patch_b"]);
        // Consumer diffs are emitted before tool execution. Deliberately deny
        // writes in both controls; successful execution is covered by the
        // separate function-tool history case, not needed for this consumer.
        assert.ok(outputs.every((item) => String(item.output).includes("read-only sandbox")));
        return new Response(render([added(final, 0), done(final, 0), terminalFor([final])]),
          { headers: { "content-type": "text/event-stream" } });
      };
      // The raw control uses a local fixture HTTP endpoint. The treatment uses
      // Token's production Provider Native HTTP handler, including normalization.
      const rawServer = mode === "raw" ? await startTokenHttpServer({
        runtime: createTokenRuntime({ clientProtocols: [{
          method: "POST", pathname: "/v1/responses",
          handle: async (request) => {
            try { return await providerResponder!(request); }
            catch (error) {
              process.stderr.write(String(error) + "\n");
              throw error;
            }
          },
        }] }), port: 0,
      }) : undefined;
      try {
        await writeFile(join(codexHome, "config.toml"), [
          'model = "openai/gpt-native"', 'model_provider = "token_replay"',
          `model_catalog_json = ${JSON.stringify(catalogPath)}`,
          'features.apply_patch_streaming_events = true',
          '[model_providers.token_replay]', 'name = "Local consumer replay"',
          `base_url = "${rawServer?.origin ?? tokenServer.origin}/v1"`,
          'wire_api = "responses"', 'requires_openai_auth = false',
        ].join("\n"));
        const result = await replayCodexPatchConsumers(cli, directory, codexHome);
        const diffs = result.updates.map((update) => ({
          callId: update.itemId,
          changes: update.changes as { path: string; diff: string }[],
        }));
        const attributed = calls.every((call, index) => diffs.some((update) =>
          update.callId === call.call_id && update.changes.some((change) =>
            change.path === `${index === 0 ? "a" : "b"}.txt` &&
            change.diff === `PATCH_${index === 0 ? "A" : "B"}\n`)));
        assert.equal(attributed, mode === "normalized", "raw control must lose consumer attribution; normalized must preserve both diffs");
        if (mode === "normalized") {
          for (const update of diffs) {
            const name = update.callId === "patch_a" ? "a" : "b";
            assert.ok(update.callId === "patch_a" || update.callId === "patch_b");
            assert.ok(update.changes.every((change) => change.path === `${name}.txt` &&
              `PATCH_${name.toUpperCase()}\n`.startsWith(change.diff)));
          }
        }
        for (const name of ["a", "b"]) {
          await assert.rejects(readFile(join(directory, `${name}.txt`)), { code: "ENOENT" });
        }
        assert.equal(stage, 2);
        assert.deepEqual(FORBIDDEN.filter((diagnostic) => result.stderr.includes(diagnostic)), []);
        process.stdout.write(JSON.stringify({ name: `custom_tool_consumer_${mode}`, diffs, attributed, completed: true }) + "\n");
      } finally {
        await rawServer?.close();
        providerResponder = undefined;
      }
    }
  }

  assert.equal(
    providerRequests,
    selectedCases.length + (runToolHistoryCase ? 2 : 0) + (runPatchConsumerCase ? 2 : 0),
  );
} finally {
  await tokenServer?.close();
  const cleanup = resolve(root);
  const insideTemp = relative(resolve(tmpdir()), cleanup);
  assert.ok(insideTemp && !insideTemp.startsWith("..") && !isAbsolute(insideTemp));
  await rm(cleanup, { recursive: true, force: true });
}
