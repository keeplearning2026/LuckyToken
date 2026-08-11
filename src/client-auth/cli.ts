import { stat } from "node:fs/promises";
import { stdout } from "node:process";
import { resolve } from "node:path";

import {
  createFileClientTokenStore,
  type ClientTokenScope,
} from "./file-token-store.js";

const CLIENT_TOKEN_HELP = `LuckyToken client-token

Usage:
  luckytoken client-token <create|rotate|remove|list> <protocol> [scope] --config <path>

Options:
  --config <path>  Strict LuckyToken JSON configuration
  --global         Select the protocol-global client token
  --project <path> Select a project-bound client token
  --token <value>  Use an explicit token for create/rotate
`;

type ParsedClientTokenArguments =
  | {
      readonly action: "list";
      readonly protocolId: string;
      readonly configPath: string;
    }
  | {
      readonly action: "remove";
      readonly protocolId: string;
      readonly configPath: string;
      readonly scope: ClientTokenScope;
    }
  | {
      readonly action: "create" | "rotate";
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
  let configPath: string | undefined;
  let globalScope = false;
  let projectPath: string | undefined;
  let explicitToken: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--config" || argument === "--project" || argument === "--token") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--config") {
        if (configPath !== undefined) throw new Error("--config may be provided once");
        configPath = value;
      } else if (argument === "--project") {
        if (projectPath !== undefined) throw new Error("--project may be provided once");
        projectPath = value;
      } else {
        if (explicitToken !== undefined) throw new Error("--token may be provided once");
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
  if (configPath === undefined) throw new Error("--config <path> is required");
  const action = positional[0];
  if (
    action !== "create" &&
    action !== "rotate" &&
    action !== "remove" &&
    action !== "list"
  ) {
    throw new Error("client-token requires create, rotate, remove, or list");
  }
  const protocolId = positional[1];
  if (protocolId === undefined || protocolId.length === 0) {
    throw new Error("client-token requires a configured Client Protocol id");
  }
  if (positional.length !== 2) throw new Error("Too many arguments for client-token");
  if (action === "list") {
    if (globalScope || projectPath !== undefined || explicitToken !== undefined) {
      throw new Error("client-token list does not accept a scope or token");
    }
    return { action, protocolId, configPath };
  }
  if (globalScope === (projectPath !== undefined)) {
    throw new Error("Select exactly one of --global or --project <path>");
  }
  if (action === "remove" && explicitToken !== undefined) {
    throw new Error("client-token remove does not accept --token");
  }
  let scope: ClientTokenScope;
  if (globalScope) {
    scope = { type: "global" };
  } else if (projectPath !== undefined) {
    scope = { type: "project", projectDir: resolve(projectPath) };
  } else {
    throw new Error("Select exactly one of --global or --project <path>");
  }
  if (action === "remove") {
    return { action, protocolId, configPath, scope };
  }
  return {
    action,
    protocolId,
    configPath,
    scope,
    ...(explicitToken === undefined ? {} : { token: explicitToken }),
  };
}

function scopeLabel(scope: ClientTokenScope): string {
  return scope.type === "global" ? "global" : `project ${scope.projectDir}`;
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
    for (const scope of scopes) stdout.write(`  ${scopeLabel(scope)}\n`);
    return;
  }
  if (parsed.action === "create" && parsed.scope.type === "project") {
    const project = await stat(parsed.scope.projectDir);
    if (!project.isDirectory()) {
      throw new Error(`Project path is not a directory: ${parsed.scope.projectDir}`);
    }
  }
  if (parsed.action === "remove") {
    const removed = await store.remove(parsed.scope);
    if (!removed) {
      throw new Error(
        `Client token scope does not exist: ${scopeLabel(parsed.scope)}`,
      );
    }
    stdout.write(
      `Removed ${scopeLabel(parsed.scope)} token for ${parsed.protocolId}.\n`,
    );
  } else {
    const token = await store[parsed.action](parsed.scope, parsed.token);
    stdout.write(
      `${parsed.action === "create" ? "Created" : "Rotated"} ${scopeLabel(parsed.scope)} token for ${parsed.protocolId}.\n`,
    );
    if (parsed.token === undefined) stdout.write(`Token: ${token}\n`);
  }
  stdout.write("Restart LuckyToken to load the new Auth snapshot.\n");
}
