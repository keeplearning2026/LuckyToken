import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { PassThrough, Writable } from "node:stream";

import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type AuthCommandResult,
  type AuthInteractionEvent,
} from "@luckytoken/application-control-plane/control-plane";

import { createControlPlaneDiscovery } from "../control-plane-discovery.js";

/**
 * CLI Provider-auth commands (Ticket 13).
 *
 * `auth query` prints the per-Provider login options and effective status;
 * `auth login <provider> <account|api-key>` runs the Provider-owned login
 * flow through the same versioned Control Plane interaction contract the
 * desktop UI uses: typed events are printed, prompts are answered on the
 * TTY (secret input masked), an empty answer cancels, and the terminal
 * outcome (success / cancelled / failed) is reported. Output never
 * contains credential or code values.
 */

async function readControlPlaneDescriptor(path: string) {
  const endpoint = await createControlPlaneDiscovery({ path }).read();
  if (endpoint === undefined) {
    throw new Error("Failed to read Control Plane descriptor");
  }
  return endpoint;
}

const AUTH_HELP = `LuckyToken control auth

Usage:
  luckytoken control auth query --descriptor <path>
  luckytoken control auth login <provider> <account|api-key> --descriptor <path>

Commands:
  query            Print the per-Provider login options and effective
                   authentication status
  login            Run the Provider-owned interactive login flow for one
                   Provider: browser/device-code URLs are printed and prompt
                   answers are read from the terminal. An empty answer
                   cancels the sign-in. Only Provider metadata decides
                   whether a flow is an account or a true subscription.

Options:
  --descriptor <path>  Current-user Control Plane discovery descriptor
`;

class MutedOutput extends Writable {
  muted = false;

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) stdout.write(chunk, encoding);
    callback();
  }
}

function printEvent(event: AuthInteractionEvent): void {
  switch (event.type) {
    case "auth_url":
      stdout.write(`Open this URL in a browser:\n${event.url}\n`);
      if (event.instructions !== undefined) {
        stdout.write(`${event.instructions}\n`);
      }
      return;
    case "device_code":
      stdout.write(
        `Open ${event.verificationUri} and enter the code ${event.userCode}\n`,
      );
      if (event.expiresInSeconds !== undefined) {
        stdout.write(
          `The code expires in ${event.expiresInSeconds} seconds; poll every ${event.intervalSeconds ?? "?"} seconds.\n`,
        );
      }
      return;
    case "info":
      if (event.links !== undefined) {
        stdout.write(
          `${event.message} ${event.links.map((link) => link.url).join(" ")}\n`,
        );
        return;
      }
      stdout.write(`${event.message}\n`);
      return;
    case "progress":
      stdout.write(`${event.message}\n`);
      return;
    case "prompt":
      // The prompt itself is rendered by the terminal question; nothing
      // further is printed here.
      return;
  }
}

export async function runAuthCli(args: readonly string[]): Promise<void> {
  if (args.includes("--help")) {
    stdout.write(AUTH_HELP);
    return;
  }
  let descriptorPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--descriptor") {
      if (descriptorPath !== undefined) {
        throw new Error("--descriptor may be provided once");
      }
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--descriptor requires a value");
      }
      descriptorPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (descriptorPath === undefined) {
    throw new Error("--descriptor <path> is required");
  }
  const action = positional[0];
  if (action === "query") {
    if (positional.length !== 1) {
      throw new Error("auth query takes no arguments");
    }
    await runQuery(descriptorPath);
    return;
  }
  if (action === "login") {
    const providerId = positional[1];
    const authType = positional[2];
    if (
      providerId === undefined ||
      (authType !== "account" && authType !== "api-key") ||
      positional.length !== 3
    ) {
      throw new Error(
        "auth login requires <provider> <account|api-key>",
      );
    }
    await runLogin(descriptorPath, providerId, authType);
    return;
  }
  throw new Error(`Unknown auth command: ${action ?? ""}`);
}

async function connect(
  descriptorPath: string,
): Promise<Awaited<ReturnType<typeof connectControlPlane>>> {
  const endpoint = await readControlPlaneDescriptor(descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  const hello = await client.hello(controlPlaneVersion);
  if (hello.type === "incompatible") {
    await client.close();
    throw new Error(
      `Control Plane contract v${controlPlaneVersion} is unsupported`,
    );
  }
  return client;
}

function fail(result: AuthCommandResult, action: string): never {
  throw new Error(
    result.error ?? `Provider auth ${action} failed (${result.outcome})`,
  );
}

async function runQuery(descriptorPath: string): Promise<void> {
  const client = await connect(descriptorPath);
  try {
    const result = await client.executeAuthCommand({ command: "query" });
    if (result.outcome !== "ok") fail(result, "query");
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

async function runLogin(
  descriptorPath: string,
  providerId: string,
  authType: "account" | "api-key",
): Promise<void> {
  const client = await connect(descriptorPath);
  const muted = new MutedOutput();
  const terminal = stdin.isTTY === true && stdout.isTTY === true;
  // Lines are queued as they arrive: an answer typed (or piped) before its
  // prompt is presented is still delivered when the prompt asks, and a
  // closed stdin (EOF) cancels a sign-in that still awaits input.
  const input = new PassThrough();
  stdin.pipe(input, { end: false });
  const readline = createInterface({
    input,
    output: muted,
    terminal,
  });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let stdinEnded = false;
  stdin.once("end", () => {
    stdinEnded = true;
    for (const waiter of waiters.splice(0)) waiter("");
  });
  readline.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else lines.push(line);
  });
  const readLine = async (): Promise<string | undefined> => {
    const buffered = lines.shift();
    if (buffered !== undefined) return buffered;
    if (stdinEnded) return undefined;
    return new Promise<string | undefined>((resolve) => {
      waiters.push(resolve);
    });
  };
  try {
    const result = await client.executeAuthCommand(
      {
        command: "login",
        providerId,
        authType: authType === "account" ? "oauth" : "api_key",
      },
      (event) => {
        printEvent(event);
        if (event.type !== "prompt") return;
        void (async () => {
          const answer = await askPrompt(
            event,
            muted,
            terminal,
            readLine,
          );
          if (answer === undefined) {
            // An empty answer or a closed stdin (EOF) cancels the
            // sign-in (value-safe).
            await client
              .respondAuthInteraction({ type: "cancel" })
              .catch(() => undefined);
            return;
          }
          await client
            .respondAuthInteraction({
              type: "prompt_response",
              promptId: event.promptId,
              value: answer,
            })
            .catch(() => undefined);
        })().catch(() => undefined);
      },
    );
    if (result.outcome === "ok") {
      stdout.write(`Signed in to ${providerId}.\n`);
      return;
    }
    if (result.outcome === "cancelled") {
      stdout.write(`Sign-in cancelled for ${providerId}.\n`);
      return;
    }
    fail(result, "login");
  } finally {
    readline.close();
    input.destroy();
    await client.close();
  }
}

/** Asks one typed prompt on the TTY. Secret input is masked; an empty
 *  answer or a closed stdin (EOF) returns undefined (cancel). */
async function askPrompt(
  event: Extract<AuthInteractionEvent, { readonly type: "prompt" }>,
  muted: MutedOutput,
  terminal: boolean,
  readLine: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (event.kind === "select") {
    stdout.write(`${event.message}\n`);
    (event.options ?? []).forEach((option, index) => {
      stdout.write(
        `  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`,
      );
    });
    stdout.write(
      `Select 1-${(event.options ?? []).length} (empty cancels): `,
    );
    const answer = await readLine();
    if (answer === undefined) return undefined;
    const trimmed = answer.trim();
    if (trimmed.length === 0) return undefined;
    const selection = Number.parseInt(trimmed, 10) - 1;
    const option = (event.options ?? [])[selection];
    if (option === undefined) {
      stdout.write("Invalid selection; cancelling.\n");
      return undefined;
    }
    return option.id;
  }
  const description = `${event.message}${event.placeholder ? ` (${event.placeholder})` : ""} (empty cancels): `;
  if (event.kind !== "secret") {
    stdout.write(description);
    const answer = await readLine();
    return answer === undefined || answer.length === 0 ? undefined : answer;
  }
  stdout.write(description);
  muted.muted = terminal;
  try {
    const answer = await readLine();
    if (terminal) stdout.write("\n");
    return answer === undefined || answer.length === 0 ? undefined : answer;
  } finally {
    muted.muted = false;
  }
}
