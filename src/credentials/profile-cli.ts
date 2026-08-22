import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { PassThrough, Writable } from "node:stream";

import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type AuthInteractionEvent,
  type ControlPlaneClient,
  type CredentialProfilesCommand,
  type CredentialProfilesCommandResult,
  type ProviderProfileAuthCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

import { createControlPlaneDiscovery } from "../control-plane-discovery.js";

const PROFILE_HELP = `LuckyToken control profiles

Usage:
  luckytoken control profiles query --descriptor <path>
  luckytoken control profiles add <provider> <api_key|oauth> <name> [--note <text>] [--use-now] --descriptor <path>
  luckytoken control profiles reconnect <provider> <credentialId> [--use-now] --descriptor <path>
  luckytoken control profiles rename <provider> <credentialId> <name> [--note <text>] --descriptor <path>
  luckytoken control profiles <activate|enable|disable|remove|recheck> <provider> <credentialId> --descriptor <path>
  luckytoken control profiles priority <provider> <credentialId> <number> --descriptor <path>
  luckytoken control profiles settings <provider> <api-key-on-429:on|off> <oauth-on-429:on|off> --descriptor <path>

Every mutation first reads the current Provider revision and then uses the
versioned Profile command. Import and export are intentionally unavailable.
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

interface ParsedArguments {
  readonly descriptorPath: string;
  readonly positional: readonly string[];
  readonly note?: string;
  readonly useNow: boolean;
}

type ProfileMutationCommand = Exclude<CredentialProfilesCommand, { command: "query" }>;
type ProfileMutationWithoutRevision = ProfileMutationCommand extends infer Command
  ? Command extends unknown
    ? Omit<Command, "expectedRevision">
    : never
  : never;

function parseArguments(args: readonly string[]): ParsedArguments {
  let descriptorPath: string | undefined;
  let note: string | undefined;
  let useNow = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--descriptor" || argument === "--note") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--descriptor") {
        if (descriptorPath !== undefined) throw new Error("--descriptor may be provided once");
        descriptorPath = value;
      } else {
        if (note !== undefined) throw new Error("--note may be provided once");
        note = value;
      }
      index += 1;
    } else if (argument === "--use-now") {
      useNow = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (descriptorPath === undefined) throw new Error("--descriptor <path> is required");
  return { descriptorPath, positional, ...(note === undefined ? {} : { note }), useNow };
}

async function connect(descriptorPath: string): Promise<ControlPlaneClient> {
  const endpoint = await createControlPlaneDiscovery({ path: descriptorPath }).read();
  if (endpoint === undefined) throw new Error("Failed to read Control Plane descriptor");
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  if ((await client.hello(controlPlaneVersion)).type !== "compatible") {
    await client.close();
    throw new Error(`Control Plane contract v${controlPlaneVersion} is unsupported`);
  }
  return client;
}

function printEvent(event: AuthInteractionEvent): void {
  if (event.type === "auth_url") {
    stdout.write(`Open this URL in a browser:\n${event.url}\n`);
    if (event.instructions !== undefined) stdout.write(`${event.instructions}\n`);
  } else if (event.type === "device_code") {
    stdout.write(`Open ${event.verificationUri} and enter the code ${event.userCode}\n`);
  } else if (event.type === "info" || event.type === "progress") {
    stdout.write(`${event.message}\n`);
  }
}

function fail(
  result: CredentialProfilesCommandResult | ProviderProfileAuthCommandResult,
  action: string,
): never {
  throw new Error(result.error ?? `Credential Profile ${action} failed (${result.outcome})`);
}

async function providerRevision(
  client: ControlPlaneClient,
  providerId: string,
): Promise<string> {
  const result = await client.executeCredentialProfilesCommand({
    command: "query",
    providerIds: [providerId],
  });
  if (result.outcome !== "ok") fail(result, "query");
  const provider = result.state.providers[0];
  if (provider?.providerId !== providerId || provider.revision === undefined) {
    throw new Error(`Provider is unavailable: ${providerId}`);
  }
  return provider.revision;
}

async function runInteractiveAuth(
  client: ControlPlaneClient,
  command: Parameters<ControlPlaneClient["executeProviderProfileAuthCommand"]>[0],
): Promise<ProviderProfileAuthCommandResult> {
  const output = new MutedOutput();
  const terminal = stdin.isTTY === true && stdout.isTTY === true;
  const input = new PassThrough();
  stdin.pipe(input, { end: false });
  const readline = createInterface({ input, output, terminal });
  try {
    return await client.executeProviderProfileAuthCommand(command, (event) => {
      printEvent(event);
      if (event.type !== "prompt") return;
      void (async () => {
        if (event.kind === "select") {
          stdout.write(`${event.message}\n`);
          (event.options ?? []).forEach((option, index) => {
            stdout.write(`  ${index + 1}. ${option.label}\n`);
          });
        }
        const prompt = event.kind === "select"
          ? "Selection (empty cancels): "
          : `${event.message} (empty cancels): `;
        output.muted = terminal && event.kind === "secret";
        let answer: string;
        try {
          answer = await readline.question(prompt);
          if (output.muted) stdout.write("\n");
        } finally {
          output.muted = false;
        }
        if (answer.length === 0) {
          await client.respondAuthInteraction({ type: "cancel" });
          return;
        }
        const value = event.kind === "select"
          ? event.options?.[Number.parseInt(answer, 10) - 1]?.id
          : answer;
        if (value === undefined) {
          await client.respondAuthInteraction({ type: "cancel" });
          return;
        }
        await client.respondAuthInteraction({
          type: "prompt_response",
          promptId: event.promptId,
          value,
        });
      })().catch(() => undefined);
    });
  } finally {
    readline.close();
    input.destroy();
  }
}

async function executeMutation(
  client: ControlPlaneClient,
  command: ProfileMutationWithoutRevision,
): Promise<void> {
  const expectedRevision = await providerRevision(client, command.providerId);
  const result = await client.executeCredentialProfilesCommand({
    ...command,
    expectedRevision,
  } as ProfileMutationCommand);
  if (result.outcome !== "ok") fail(result, command.command);
  stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runProfileCli(args: readonly string[]): Promise<void> {
  if (args.includes("--help")) {
    stdout.write(PROFILE_HELP);
    return;
  }
  const parsed = parseArguments(args);
  const [action, providerId, credentialId, value] = parsed.positional;
  if (action === undefined) throw new Error("Profile command is required");
  const client = await connect(parsed.descriptorPath);
  try {
    if (action === "query") {
      if (parsed.positional.length !== 1) throw new Error("profiles query takes no arguments");
      const result = await client.executeCredentialProfilesCommand({ command: "query" });
      if (result.outcome !== "ok") fail(result, "query");
      stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (action === "add") {
      const authType = credentialId;
      const displayName = value;
      if (
        providerId === undefined ||
        (authType !== "api_key" && authType !== "oauth") ||
        displayName === undefined ||
        parsed.positional.length !== 4
      ) {
        throw new Error("profiles add requires <provider> <api_key|oauth> <name>");
      }
      const result = await runInteractiveAuth(client, {
        command: "login",
        providerId,
        authType,
        displayName,
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
        useNow: parsed.useNow,
        expectedRevision: await providerRevision(client, providerId),
      });
      if (result.outcome !== "ok" && result.outcome !== "cancelled") fail(result, "add");
      stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (action === "reconnect") {
      if (providerId === undefined || credentialId === undefined || parsed.positional.length !== 3) {
        throw new Error("profiles reconnect requires <provider> <credentialId>");
      }
      const result = await runInteractiveAuth(client, {
        command: "reconnect",
        providerId,
        credentialId,
        useNow: parsed.useNow,
        expectedRevision: await providerRevision(client, providerId),
      });
      if (result.outcome !== "ok" && result.outcome !== "cancelled") fail(result, "reconnect");
      stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (providerId === undefined) throw new Error(`profiles ${action} requires <provider>`);
    if (action === "settings") {
      if (
        credentialId !== "on" && credentialId !== "off" ||
        value !== "on" && value !== "off" ||
        parsed.positional.length !== 4
      ) {
        throw new Error("profiles settings requires <provider> <api-key:on|off> <oauth:on|off>");
      }
      await executeMutation(client, {
        command: "set_switch_policy",
        providerId,
        apiKeyOn429: credentialId === "on",
        oauthOn429: value === "on",
      });
      return;
    }
    if (credentialId === undefined) throw new Error(`profiles ${action} requires <credentialId>`);
    if (action === "rename") {
      if (value === undefined || parsed.positional.length !== 4) {
        throw new Error("profiles rename requires <provider> <credentialId> <name>");
      }
      await executeMutation(client, {
        command: "update_metadata",
        providerId,
        credentialId,
        displayName: value,
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
      });
      return;
    }
    if (action === "priority") {
      const priority = Number(value);
      if (!Number.isSafeInteger(priority) || parsed.positional.length !== 4) {
        throw new Error("profiles priority requires an integer <number>");
      }
      await executeMutation(client, { command: "set_priority", providerId, credentialId, priority });
      return;
    }
    const commands = {
      activate: { command: "activate" as const },
      enable: { command: "set_enabled" as const, enabled: true },
      disable: { command: "set_enabled" as const, enabled: false },
      remove: { command: "remove" as const },
      recheck: { command: "recheck" as const },
    };
    const command = commands[action as keyof typeof commands];
    if (command === undefined || parsed.positional.length !== 3) {
      throw new Error(`Unknown profiles command: ${action}`);
    }
    await executeMutation(client, { ...command, providerId, credentialId });
  } finally {
    await client.close();
  }
}
