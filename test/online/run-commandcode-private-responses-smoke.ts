import {
  createResponsesSmokeHarness,
  responsesVisibleText,
} from "./responses-smoke-harness.js";

const MARKER = "LT_PRIVATE_RESPONSES_SMOKE";
const MODEL = "commandcode-private/deepseek/deepseek-v4.1-flash";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function run(): Promise<void> {
  const harness = await createResponsesSmokeHarness({
    providerId: "commandcode-private",
    model: MODEL,
    apiKeyFile: "CommandcodeAPIKey.txt",
  });
  try {
    if (harness.providerApi !== "commandcode-private") {
      throw new Error(`online_private_responses_api_${harness.providerApi}`);
    }

    const response = await harness.post({
      model: harness.selector,
      input: `Reply with the exact token ${MARKER} and no other text.`,
      max_output_tokens: 256,
      reasoning: { effort: "high" },
    });
    if (response.status !== 200 || response.json === undefined) {
      throw new Error(
        `online_private_responses_http_${response.status}: ${response.text.slice(0, 512)}`,
      );
    }
    const visible = responsesVisibleText(response.json);
    if (visible.trim().length === 0) {
      throw new Error("online_private_responses_visible_empty");
    }

    const exchange = harness.exchanges.findLast((entry) =>
      entry.body.includes(MARKER),
    );
    if (exchange === undefined) {
      throw new Error("online_private_responses_upstream_missing");
    }
    const pathname = new URL(exchange.url).pathname;
    if (pathname !== "/alpha/generate") {
      throw new Error(`online_private_responses_path_${pathname}`);
    }
    const payload = JSON.parse(exchange.body) as unknown;
    if (
      !isRecord(payload) ||
      !isRecord(payload.params) ||
      payload.params.model !== harness.upstreamModelId
    ) {
      throw new Error("online_private_responses_model_mismatch");
    }

    process.stdout.write(`${JSON.stringify({
      status: "pass",
      provider: "commandcode-private",
      clientProtocol: "openai-responses",
      model: harness.selector,
      providerApi: harness.providerApi,
      upstreamPath: pathname,
    }, null, 2)}\n`);
  } finally {
    await harness.close();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `CommandCode Private Responses smoke failed\n${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
