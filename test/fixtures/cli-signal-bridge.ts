import { runTokenCli } from "../../src/cli.js";

const serializedArguments = process.env.TOKEN_TEST_CLI_ARGS;
if (serializedArguments === undefined) {
  throw new Error("TOKEN_TEST_CLI_ARGS is required");
}

process.stdin.once("data", () => process.emit("SIGTERM"));
await runTokenCli(JSON.parse(serializedArguments) as string[]);
