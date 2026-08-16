import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";

import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type ClientTokenCommand,
} from "@luckytoken/application-control-plane/control-plane";

import { readControlPlaneDescriptor } from "../control-plane-discovery.js";
import {
  createFileClientTokenStore,
  type ClientTokenScope,
} from "./file-token-store.js";

/**
 * CLI Client Token commands (Ticket 16 + repair).
 *
 * Two modes share the same action verbs:
 *
 * - Live mode (`--descriptor <path>`): list/reveal/rotate/remove run through
 *   the versioned Control Plane Client Token channel against the running
 *   application's live authority. Every mutation is revision-locked, so CLI
 *   and UI can never lose an update or resurrect an old token.
 *
 * - Offline mode (`--config <path>`): the restored directory-token file
 *   management (create/rotate/remove/list with --global or --project)
 *   operates directly on the protocol's token file, exactly as before
 *   Ticket 16. Mutations carry the file's current revision as a
 *   compare-and-swap generation, so an offline write can never clobber a
 *   newer state written by a running application.
 */

const CLIENT_TOKEN_HELP = `LuckyToken client-token

Usage (live, running application):
  luckytoken client-token <list|reveal|rotate|remove> <protocol> --descriptor <path> [--token <value>]

Usage (offline token file):
  luckytoken client-token <create|rotate|remove|list> <protocol> --config <path> [--global|--project <path>] [--token <value>]

Options:
  --descriptor <path>  Current-user Control Plane discovery descriptor (live mode)
  --config <path>      Strict LuckyToken JSON configuration (offline token file mode)
  --global             Select the protocol-global client token
  --project <path>     Select a project-bound client token
  --token <value>      Use an explicit token for create/rotate
`;

type ParsedClientTokenArguments =
  | {
      readonly mode: "live";
      readonly action: "list" | "reveal" | "rotate" | "remove";
      readonly protocolId: string;
      readonly descriptorPath: string;
      readonly token?: string;
    }
  | {
      readonly mode: "offline";
      readonly action: "create" | "rotate" | "remove" | "list";
      readonly protocolId: string;
      readonly configPath: string;
      readonly scope: ClientTokenScope;
      readonly token?: string;
    };

export interface ClientTokenCliDependencies {
  resolveAuthFile(
    configPath: string,
    protocolId: string,
  ): Promise<string | undefined>;
}

function parseClientTokenArguments(
  args: readonly string[],
): ParsedClientTokenArguments | undefined {
  if (args.includes("--help")) return undefined;
  let descriptorPath: string | undefined;
  let configPath: string | undefined;
  let globalScope = false;
  let projectPath: string | undefined;
  let explicitToken: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (
      argument === "--descriptor" ||
      argument === "--config" ||
      argument === "--project" ||
      argument === "--token"
    ) {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--descriptor") {
        if (descriptorPath !== undefined) {
          throw new Error("--descriptor may be provided once");
        }
        descriptorPath = value;
      } else if (argument === "--config") {
        if (configPath !== undefined) {
          throw new Error("--config may be provided once");
        }
        configPath = value;
      } else if (argument === "--project") {
        if (projectPath !== undefined) {
          throw new Error("--project may be provided once");
        }
        projectPath = value;
      } else {
        if (explicitToken !== undefined) {
          throw new Error("--token may be provided once");
        }
        explicitToken = value;
      }
      index += 1;
      continue;
    }
    if (argument === "--global") {
      if (globalScope) throw new Error("--global may be provided once");
      globalScope = true;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (
    (descriptorPath === undefined) === (configPath === undefined)
  ) {
    throw new Error(
      "Select exactly one of --descriptor <path> (live) or --config <path> (offline token file)",
    );
  }
  const action = positional[0];
  const protocolId = positional[1];
  if (protocolId === undefined || protocolId.length === 0) {
    throw new Error("client-token requires a Client Protocol id");
  }
  if (positional.length !== 2) {
    throw new Error("Too many arguments for client-token");
  }
  if (descriptorPath !== undefined) {
    if (
      action !== "list" &&
      action !== "reveal" &&
      action !== "rotate" &&
      action !== "remove"
    ) {
      throw new Error(
        action === "create"
          ? "create is an offline token-file action; the running application creates tokens when a Client Protocol is enabled"
          : `Unknown client-token action for the live Control Plane: ${action}`,
      );
    }
    if (globalScope || projectPath !== undefined) {
      throw new Error("Live mode does not accept --global or --project");
    }
    if (action !== "rotate" && explicitToken !== undefined) {
      throw new Error("--token is only valid for rotate in live mode");
    }
    return {
      mode: "live",
      action,
      protocolId,
      descriptorPath,
      ...(explicitToken === undefined ? {} : { token: explicitToken }),
    };
  }
  if (
    action !== "create" &&
    action !== "rotate" &&
    action !== "remove" &&
    action !== "list"
  ) {
    throw new Error(
      action === "reveal"
        ? "reveal is a live Control Plane action; offline token files never expose tokens"
        : `Unknown client-token action for the offline token file: ${action}`,
    );
  }
  if (action === "list") {
    if (globalScope || projectPath !== undefined || explicitToken !== undefined) {
      throw new Error("client-token list does not accept a scope or token");
    }
    return {
      mode: "offline",
      action,
      protocolId,
      configPath: configPath as string,
      scope: { type: "global" },
    };
  }
  if (globalScope === (projectPath !== undefined)) {
    throw new Error("Select exactly one of --global or --project <path>");
  }
  if (action === "remove" && explicitToken !== undefined) {
    throw new Error("client-token remove does not accept --token");
  }
  const scope: ClientTokenScope = globalScope
    ? { type: "global" }
    : { type: "project", projectDir: resolve(projectPath as string) };
  return {
    mode: "offline",
    action,
    protocolId,
    configPath: configPath as string,
    scope,
    ...(explicitToken === undefined ? {} : { token: explicitToken }),
  };
}

function scopeLabel(scope: ClientTokenScope): string {
  return scope.type === "global" ? "global" : `project ${scope.projectDir}`;
}

function scopeLine(scope: ClientTokenScope): string {
  return scope.type === "global"
    ? "  global"
    : `  project ${scope.projectDir}`;
}

async function runLiveClientTokenCli(
  parsed: Extract<ParsedClientTokenArguments, { readonly mode: "live" }>,
): Promise<void> {
  const endpoint = await readControlPlaneDescriptor(parsed.descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    const hello = await client.hello(controlPlaneVersion);
    if (hello.type === "incompatible") {
      throw new Error(
        `Control Plane contract v${controlPlaneVersion} is unsupported`,
      );
    }
    const execute = (command: ClientTokenCommand) =>
      client.executeClientTokenCommand(command);

    if (parsed.action === "list") {
      const result = await execute({
        command: "list",
        protocolId: parsed.protocolId,
      });
      if (result.outcome !== "ok") {
        throw new Error(result.error ?? "Client Token list failed");
      }
      const scopes = result.scopes ?? [];
      if (scopes.length === 0) {
        stdout.write(`No client tokens for ${parsed.protocolId}.\n`);
        return;
      }
      stdout.write(
        `Client tokens for ${parsed.protocolId} (revision ${result.revision}):\n`,
      );
      for (const scope of scopes) {
        stdout.write(
          scope.type === "global"
            ? `  global  ${scope.maskedToken}\n`
            : `  project ${scope.projectDir}  ${scope.maskedToken}\n`,
        );
      }
      return;
    }

    if (parsed.action === "reveal") {
      const result = await execute({
        command: "reveal",
        protocolId: parsed.protocolId,
      });
      if (result.outcome !== "ok") {
        throw new Error(result.error ?? "Client Token reveal failed");
      }
      stdout.write(`${result.token}\n`);
      return;
    }

    // Mutations are revision-locked: read the current revision first so a
    // concurrent UI/CLI change surfaces as a conflict instead of being
    // overwritten.
    const listed = await execute({
      command: "list",
      protocolId: parsed.protocolId,
    });
    if (listed.outcome !== "ok") {
      throw new Error(listed.error ?? "Client Token list failed");
    }
    const command: ClientTokenCommand =
      parsed.action === "rotate"
        ? {
            command: "rotate",
            protocolId: parsed.protocolId,
            expectedRevision: listed.revision,
            ...(parsed.token === undefined ? {} : { token: parsed.token }),
          }
        : {
            command: "remove",
            protocolId: parsed.protocolId,
            expectedRevision: listed.revision,
          };
    const result = await execute(command);
    if (result.outcome !== "ok") {
      throw new Error(result.error ?? `Client Token ${parsed.action} failed`);
    }
    stdout.write(
      `${parsed.action === "rotate" ? "Rotated" : "Removed"} the global client token for ${parsed.protocolId}.\n`,
    );
    if (parsed.action === "rotate" && parsed.token === undefined) {
      // Explicit local reveal of the freshly generated active token.
      const revealed = await execute({
        command: "reveal",
        protocolId: parsed.protocolId,
      });
      if (revealed.outcome === "ok") stdout.write(`Token: ${revealed.token}\n`);
    }
    if (parsed.action === "remove" && (result.scopes ?? []).length === 0) {
      stdout.write(
        "No client tokens remain; model requests return 401 until a token is created.\n",
      );
    }
  } finally {
    await client.close();
  }
}

async function runOfflineClientTokenCli(
  parsed: Extract<ParsedClientTokenArguments, { readonly mode: "offline" }>,
  dependencies: ClientTokenCliDependencies,
): Promise<void> {
  const authFile = await dependencies.resolveAuthFile(
    parsed.configPath,
    parsed.protocolId,
  );
  if (authFile === undefined) {
    throw new Error(`Client Protocol is not configured: ${parsed.protocolId}`);
  }
  const store = createFileClientTokenStore({ path: authFile });
  if (parsed.action === "list") {
    const scopes = await store.list();
    if (scopes.length === 0) {
      stdout.write(`No client tokens for ${parsed.protocolId}.\n`);
      return;
    }
    stdout.write(`Client tokens for ${parsed.protocolId}:\n`);
    for (const scope of scopes) stdout.write(`${scopeLine(scope)}\n`);
    return;
  }
  if (parsed.action === "create" && parsed.scope.type === "project") {
    const project = await stat(parsed.scope.projectDir);
    if (!project.isDirectory()) {
      throw new Error(
        `Project path is not a directory: ${parsed.scope.projectDir}`,
      );
    }
  }
  // The file's revision is the compare-and-swap generation: an offline
  // mutation can never overwrite a state a running application wrote after
  // this command started.
  const current = await store.snapshot();
  if (parsed.action === "remove") {
    const removed = await store.remove(parsed.scope, current.revision);
    if (!removed) {
      throw new Error(
        `Client token scope does not exist: ${scopeLabel(parsed.scope)}`,
      );
    }
    stdout.write(
      `Removed ${scopeLabel(parsed.scope)} token for ${parsed.protocolId}.\n`,
    );
  } else {
    const token = await store[parsed.action](
      parsed.scope,
      parsed.token,
      current.revision,
    );
    stdout.write(
      `${parsed.action === "create" ? "Created" : "Rotated"} ${scopeLabel(parsed.scope)} token for ${parsed.protocolId}.\n`,
    );
    if (parsed.token === undefined) stdout.write(`Token: ${token}\n`);
  }
  stdout.write("Restart LuckyToken to load the new Auth snapshot.\n");
}

export async function runClientTokenCli(
  args: readonly string[],
  dependencies: ClientTokenCliDependencies,
): Promise<void> {
  const parsed = parseClientTokenArguments(args);
  if (parsed === undefined) {
    stdout.write(CLIENT_TOKEN_HELP);
    return;
  }
  if (parsed.mode === "live") {
    await runLiveClientTokenCli(parsed);
    return;
  }
  await runOfflineClientTokenCli(parsed, dependencies);
}
