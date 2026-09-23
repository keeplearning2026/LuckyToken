import {
  createResponsesSmokeHarness,
  responsesVisibleText,
} from "./responses-smoke-harness.js";

const MARKER = "LT_GOAT_RESPONSES_SMOKE";
const MODEL = "commandcode-goat/deepseek/deepseek-v4.1-flash";
const NATIVE_TOP_P = 0.83;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function run(): Promise<void> {
  const harness = await createResponsesSmokeHarness({
    providerId: "commandcode-goat",
    model: MODEL,
    apiKeyFile: "CommandcodeAPIKey.txt",
  });
  try {
    if (harness.providerApi !== "openai-responses") {
      throw new Error(`online_goat_responses_api_${harness.providerApi}`);
    }

    const response = await harness.post({
      model: harness.selector,
      input: `Reply with the exact token ${MARKER} and no other text.`,
      max_output_tokens: 256,
      top_p: NATIVE_TOP_P,
    });
    if (response.status !== 200 || response.json === undefined) {
      throw new Error(
        `online_goat_responses_http_${response.status}: ${response.text.slice(0, 512)}`,
      );
    }
    const visible = responsesVisibleText(response.json);
    if (visible.trim().length === 0) {
      throw new Error("online_goat_responses_visible_empty");
    }

    const exchange = harness.exchanges.findLast((entry) =>
      entry.body.includes(MARKER),
    );
    if (exchange === undefined) {
      throw new Error("online_goat_responses_upstream_missing");
    }
    const pathname = new URL(exchange.url).pathname;
    if (pathname !== "/provider/v1/responses") {
      throw new Error(`online_goat_responses_path_${pathname}`);
    }
    const payload = JSON.parse(exchange.body) as unknown;
    if (
      !isRecord(payload) ||
      payload.model !== harness.upstreamModelId ||
      payload.top_p !== NATIVE_TOP_P
    ) {
      throw new Error("online_goat_responses_native_preservation_mismatch");
    }

    process.stdout.write(`${JSON.stringify({
      status: "pass",
      provider: "commandcode-goat",
      clientProtocol: "openai-responses",
      model: harness.selector,
      providerApi: harness.providerApi,
      lane: "provider-native",
      upstreamPath: pathname,
      preservedTopP: NATIVE_TOP_P,
    }, null, 2)}\n`);
  } finally {
    await harness.close();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `CommandCode Goat Responses smoke failed\n${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
