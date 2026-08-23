import { runOpenAIResponsesOnlineSuite } from "./run-openai-responses.js";

void runOpenAIResponsesOnlineSuite(
  [
    "--provider",
    "commandcode-goat",
    "--model",
    "commandcode-goat/deepseek/deepseek-v4-flash",
    "--api-key-file",
    "CommandcodeAPIKey.txt",
    "--concurrency",
    "1",
  ],
).catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`CommandCode Goat Responses suite failed\n${detail}\n`);
  process.exitCode = 1;
});
