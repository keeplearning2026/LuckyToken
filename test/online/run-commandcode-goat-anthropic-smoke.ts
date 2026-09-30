import {
  createAnthropicOnlineHarness,
  isOnlineRecord,
} from "./run-anthropic-messages.js";

const MARKER = "LT_GOAT_ANTHROPIC_SMOKE";
const IMAGE_MARKER = "LT_GOAT_ANTHROPIC_IMAGE_SMOKE";
const MODEL = "commandcode-goat/deepseek/deepseek-v4.1-flash";
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

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

    const imageResponse = await harness.postJson({
      model: harness.selector,
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `The attached image is a single 1x1 pixel. Reply with the exact token ${IMAGE_MARKER} and no other text.`,
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: ONE_PIXEL_PNG,
            },
          },
        ],
      }],
    });
    if (imageResponse.status !== 200) {
      throw new Error(
        `online_goat_anthropic_image_http_${imageResponse.status}: ${imageResponse.text.slice(0, 512)}`,
      );
    }
    const imageParsed = JSON.parse(imageResponse.text) as unknown;
    if (
      !isOnlineRecord(imageParsed) ||
      !visibleText(imageParsed).includes(IMAGE_MARKER)
    ) {
      throw new Error("online_goat_anthropic_image_visible_mismatch");
    }
    const imageExchange = harness.exchanges.findLast((entry) =>
      entry.body.includes("input_image"),
    );
    if (imageExchange === undefined) {
      throw new Error("online_goat_anthropic_image_upstream_missing");
    }
    const imagePayload = JSON.parse(imageExchange.body) as unknown;
    const imageWire = JSON.stringify(imagePayload);
    if (
      !isOnlineRecord(imagePayload) ||
      imagePayload.model !== "deepseek/deepseek-v4.1-flash" ||
      !Array.isArray(imagePayload.input) ||
      !imageWire.includes('"type":"input_image"') ||
      !imageWire.includes("data:image/png;base64,") ||
      !imageWire.includes(IMAGE_MARKER)
    ) {
      throw new Error("online_goat_anthropic_image_wire_mismatch");
    }

    process.stdout.write(`${JSON.stringify({
      status: "pass",
      provider: "commandcode-goat",
      clientProtocol: "anthropic-messages",
      model: harness.selector,
      providerApi: harness.providerApi,
      lane: "semantic-conversion",
      upstreamPath: pathname,
      imageCase: "pass",
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
