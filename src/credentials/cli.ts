import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type CredentialCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

import { readControlPlaneDescriptor } from "../control-plane-discovery.js";

/**
 * CLI Credential commands (Ticket 12).
 *
 * Every mutation runs through the versioned Control Plane Credential
 * channel against the running application's single serialized Credential
 * Authority: login/logout carry the expected revision from a prior query
 * (a stale CLI can never overwrite a newer credential), and import is
 * confirmed Provider by Provider against the preview plan before the apply
 * writes only the confirmed selections.
 *
 * Output never contains credential values: query prints the sanitized
 * projection, login/logout print fixed structural messages, and import
 * prints the entry plan/summary only.
 */

const CREDENTIALS_HELP = `LuckyToken control credentials

Usage:
  luckytoken control credentials query --descriptor <path>
  luckytoken control credentials login <provider> <value> --descriptor <path> [--overwrite]
  luckytoken control credentials logout <provider> --descriptor <path>
  luckytoken control credentials import <file> --descriptor <path> [--overwrite-all]

Commands:
  query            Print the sanitized auth.json projection and per-Provider
                   effective authentication status
  login            Store an API-key credential for one Provider. <value> may be a
                   literal secret, an environment reference ($VAR / \${VAR}) or a
                   !command source; it is stored verbatim and resolved per request
                   with the pinned Pi semantics. Replacing an occupied slot
                   requires --overwrite.
  logout           Remove only the stored auth.json value for the Provider;
                   environment and models.json sources remain effective
  import           Validate a Pi-compatible auth.json file, confirm each
                   overwrite Provider by Provider, then apply the confirmed
                   selections (--overwrite-all confirms every overwrite)

Options:
  --descriptor <path>  Current-user Control Plane discovery descriptor
  --overwrite          Confirm replacement of an occupied credential slot
  --overwrite-all      Confirm every overwrite during import
`;

export async function runCredentialCli(args: readonly string[]): Promise<void> {
  if (args.includes("--help")) {
    stdout.write(CREDENTIALS_HELP);
    return;
  }
  let descriptorPath: string | undefined;
  let overwrite = false;
  let overwriteAll = false;
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
    if (argument === "--overwrite") {
      if (overwrite) throw new Error("--overwrite may be provided once");
      overwrite = true;
      continue;
    }
    if (argument === "--overwrite-all") {
      if (overwriteAll) throw new Error("--overwrite-all may be provided once");
      overwriteAll = true;
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
      throw new Error("credentials query takes no arguments");
    }
    await runQuery(descriptorPath);
    return;
  }
  if (action === "login") {
    const providerId = positional[1];
    const value = positional[2];
    if (
      providerId === undefined ||
      value === undefined ||
      positional.length !== 3
    ) {
      throw new Error("credentials login requires <provider> <value>");
    }
    await runLogin(descriptorPath, providerId, value, overwrite);
    return;
  }
  if (action === "logout") {
    const providerId = positional[1];
    if (providerId === undefined || positional.length !== 2) {
      throw new Error("credentials logout requires <provider>");
    }
    if (overwrite || overwriteAll) {
      throw new Error("credentials logout does not accept --overwrite");
    }
    await runLogout(descriptorPath, providerId);
    return;
  }
  if (action === "import") {
    const file = positional[1];
    if (file === undefined || positional.length !== 2) {
      throw new Error("credentials import requires <file>");
    }
    if (overwrite) {
      throw new Error("use --overwrite-all to confirm every import overwrite");
    }
    await runImport(descriptorPath, file, overwriteAll);
    return;
  }
  throw new Error(`Unknown credentials command: ${action ?? ""}`);
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

function fail(result: CredentialCommandResult, action: string): never {
  throw new Error(
    result.error ?? `Credential ${action} failed (${result.outcome})`,
  );
}

async function runQuery(descriptorPath: string): Promise<void> {
  const client = await connect(descriptorPath);
  try {
    const result = await client.executeCredentialCommand({ command: "query" });
    if (result.outcome !== "ok") fail(result, "query");
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

async function runLogin(
  descriptorPath: string,
  providerId: string,
  value: string,
  overwrite: boolean,
): Promise<void> {
  const client = await connect(descriptorPath);
  try {
    const queried = await client.executeCredentialCommand({ command: "query" });
    if (queried.outcome !== "ok") fail(queried, "query");
    const result = await client.executeCredentialCommand({
      command: "login",
      providerId,
      expectedRevision: queried.revision,
      value,
      overwrite,
    });
    if (result.outcome === "overwrite_required") {
      throw new Error(
        `Provider ${providerId} already has a stored credential. Confirm the replacement with --overwrite.`,
      );
    }
    if (result.outcome !== "ok") fail(result, "login");
    stdout.write(`Stored API key credential for ${providerId}.\n`);
  } finally {
    await client.close();
  }
}

async function runLogout(
  descriptorPath: string,
  providerId: string,
): Promise<void> {
  const client = await connect(descriptorPath);
  try {
    const queried = await client.executeCredentialCommand({ command: "query" });
    if (queried.outcome !== "ok") fail(queried, "query");
    const result = await client.executeCredentialCommand({
      command: "logout",
      providerId,
      expectedRevision: queried.revision,
    });
    if (result.outcome !== "ok") fail(result, "logout");
    stdout.write(
      result.changed === true
        ? `Stored credential removed for ${providerId}.\n`
        : `No stored credential to remove for ${providerId}.\n`,
    );
  } finally {
    await client.close();
  }
}

async function runImport(
  descriptorPath: string,
  file: string,
  overwriteAll: boolean,
): Promise<void> {
  const content = await readFile(file, "utf8");
  const client = await connect(descriptorPath);
  try {
    const queried = await client.executeCredentialCommand({ command: "query" });
    if (queried.outcome !== "ok") fail(queried, "query");
    const preview = await client.executeCredentialCommand({
      command: "import_preview",
      expectedRevision: queried.revision,
      content,
    });
    if (preview.outcome === "invalid") fail(preview, "import");
    if (preview.outcome !== "ok") fail(preview, "import preview");
    const entries = preview.previewEntries ?? [];
    const overwrites = entries.filter((entry) => entry.wouldOverwrite);
    if (overwrites.length > 0) {
      stdout.write(
        `The import would overwrite ${overwrites.length} stored credential(s): ${overwrites
          .map((entry) => entry.providerId)
          .join(", ")}\n`,
      );
    }
    const selections = await confirmSelections(entries, overwriteAll);
    if (selections.length === 0) {
      stdout.write("Nothing to import.\n");
      return;
    }
    const applied = await client.executeCredentialCommand({
      command: "import_apply",
      expectedRevision: preview.revision,
      importId: preview.importId as string,
      selections,
    });
    if (applied.outcome === "overwrite_required") {
      throw new Error(
        "One or more Providers already have stored credentials. Confirm each overwrite (or re-run with --overwrite-all).",
      );
    }
    if (applied.outcome === "conflict") {
      const failedEntries = (applied.entries ?? [])
        .filter((entry) => entry.outcome !== "applied")
        .map((entry) => `${entry.providerId} (${entry.outcome})`);
      throw new Error(
        applied.error ?? `Import conflicted for: ${failedEntries.join(", ")}`,
      );
    }
    if (applied.outcome !== "ok") fail(applied, "import");
    const summary = (applied.entries ?? [])
      .map((entry) => `${entry.providerId} (${entry.outcome})`)
      .join(", ");
    stdout.write(`Imported credentials: ${summary}.\n`);
  } finally {
    await client.close();
  }
}

/** Per-Provider overwrite confirmation: interactive prompts on a TTY,
 *  otherwise every overwrite requires the explicit --overwrite-all flag. */
async function confirmSelections(
  entries: NonNullable<CredentialCommandResult["previewEntries"]>,
  overwriteAll: boolean,
): Promise<
  readonly { readonly providerId: string; readonly overwrite: boolean }[]
> {
  const selections: { providerId: string; overwrite: boolean }[] = [];
  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  const readline = interactive
    ? createInterface({ input: stdin, output: stdout, terminal: true })
    : undefined;
  try {
    for (const entry of entries) {
      if (!entry.wouldOverwrite) {
        selections.push({ providerId: entry.providerId, overwrite: false });
        continue;
      }
      if (overwriteAll) {
        selections.push({ providerId: entry.providerId, overwrite: true });
        continue;
      }
      if (readline === undefined) {
        throw new Error(
          "Overwrite confirmation required: re-run with --overwrite-all or run interactively to confirm each overwrite",
        );
      }
      const answer = await readline.question(
        `Provider ${entry.providerId} already has a stored credential. Overwrite it? [y/N] `,
      );
      selections.push({
        providerId: entry.providerId,
        overwrite: answer.trim().toLowerCase() === "y",
      });
    }
  } finally {
    await readline?.close();
  }
  return selections;
}
