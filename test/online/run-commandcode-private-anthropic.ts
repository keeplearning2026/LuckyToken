import { runAnthropicMessagesOnlineSuite } from "./run-anthropic-messages.js";

void runAnthropicMessagesOnlineSuite([
  "--provider",
  "commandcode-private",
  "--model",
  "commandcode-private/deepseek/deepseek-v4-flash",
  "--api-key-file",
  "CommandcodeAPIKey.txt",
]).catch((error: unknown) => {
  process.stderr.write(
    `CommandCode Private Anthropic suite failed\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
