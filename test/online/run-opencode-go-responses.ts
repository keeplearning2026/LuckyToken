import { runOpenAIResponsesOnlineSuite } from "./run-openai-responses.js";

void runOpenAIResponsesOnlineSuite(
  [
    "--provider",
    "opencode-go",
    "--model",
    "deepseek-v4-flash",
    "--api-key-file",
    "OpenCodeAPIkey.txt",
    "--alias",
    "opencode-go/deepseek-v4-flash",
    "--concurrency",
    "1",
  ],
).catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`OpenCode Go Responses suite failed\n${detail}\n`);
  process.exitCode = 1;
});
