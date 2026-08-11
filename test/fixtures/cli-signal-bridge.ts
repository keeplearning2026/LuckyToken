import { runLuckyTokenCli } from "../../src/cli.js";

const serializedArguments = process.env.LUCKYTOKEN_TEST_CLI_ARGS;
if (serializedArguments === undefined) {
  throw new Error("LUCKYTOKEN_TEST_CLI_ARGS is required");
}

process.stdin.once("data", () => process.emit("SIGTERM"));
await runLuckyTokenCli(JSON.parse(serializedArguments) as string[]);
