import { runAnthropicMessagesOnlineSuite } from "./run-anthropic-messages.js";

void runAnthropicMessagesOnlineSuite([
  "--provider",
  "opencode-go",
  "--model",
  "deepseek-v4-flash",
  "--api-key-file",
  "OpenCodeAPIkey.txt",
  "--alias",
  "opencode-go/deepseek-v4-flash",
]).catch((error: unknown) => {
  process.stderr.write(
    `OpenCode Go Anthropic suite failed\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
