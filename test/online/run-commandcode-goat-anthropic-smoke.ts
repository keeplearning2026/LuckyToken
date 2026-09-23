import {
  createAnthropicOnlineHarness,
  isOnlineRecord,
} from "./run-anthropic-messages.js";

const MARKER = "LT_GOAT_ANTHROPIC_SMOKE";
const MODEL = "commandcode-goat/deepseek/deepseek-v4.1-flash";

function visibleText(
  result: Readonly<Record<string, unknown>>,
): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter(
      (block): block is Readonly<Record<string, unknown>> =>
        isOnlineRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text as string)
    .join("");
}

async function run(): Promise<void> {
  const harness = await createAnthropicOnlineHarness({
    providerId: "commandcode-goat",
    model: MODEL,
    apiKeyFile: "CommandcodeAPIKey.txt",
  });
  try {
    if (harness.providerApi !== "openai-responses") {
      throw new Error(`online_goat_anthropic_api_${harness.providerApi}`);
    }

    const response = await harness.postJson({
      model: harness.selector,
      max_tokens: 256,
      messages: [{
        role: "user",
        content: `Reply with the exact token ${MARKER} and no other text.`,
      }],
    });
    if (response.status !== 200) {
      throw new Error(
        `online_goat_anthropic_http_${response.status}: ${response.text.slice(0, 512)}`,
      );
    }
    const parsed = JSON.parse(response.text) as unknown;
    if (!isOnlineRecord(parsed) || visibleText(parsed).trim().length === 0) {
      throw new Error("online_goat_anthropic_visible_empty");
    }

    const exchange = harness.exchanges.findLast((entry) =>
      entry.body.includes(MARKER),
    );
    if (exchange === undefined) {
      throw new Error("online_goat_anthropic_upstream_missing");
    }
    const pathname = new URL(exchange.url).pathname;
    if (pathname !== "/provider/v1/responses") {
      throw new Error(`online_goat_anthropic_path_${pathname}`);
    }
    const payload = JSON.parse(exchange.body) as unknown;
    if (
      !isOnlineRecord(payload) ||
      payload.model !== "deepseek/deepseek-v4.1-flash" ||
      !Array.isArray(payload.input)
    ) {
      throw new Error("online_goat_anthropic_semantic_wire_mismatch");
    }

    process.stdout.write(`${JSON.stringify({
      status: "pass",
      provider: "commandcode-goat",
      clientProtocol: "anthropic-messages",
      model: harness.selector,
      providerApi: harness.providerApi,
      lane: "semantic-conversion",
      upstreamPath: pathname,
    }, null, 2)}\n`);
  } finally {
    await harness.close();
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `CommandCode Goat Anthropic smoke failed\n${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
