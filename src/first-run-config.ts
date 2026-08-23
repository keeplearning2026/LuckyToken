import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_MAX_REQUEST_BYTES } from "./data-plane-limits.js";

const CONFIG_FILE_MODE = 0o600;

// Ticket 26: the desktop-owned backend's first-run configuration. When the
// installed launcher points at a config path that does not exist yet, the
// TypeScript side owns creating the transparent user config from this fixed
// template (both default Client Protocols enabled, loopback-only, the fixed
// port). It is strictly idempotent: an existing file — valid or deliberately
// incompatible — is never touched; incompatible files keep flowing into the
// recovery Control Plane exactly as before.

function firstRunConfig(): unknown {
  return {
    schemaVersion: "luckytoken-config-v2",
    server: {
      port: 3000,
    },
    clientProtocols: {
      "anthropic-messages": {
        conversion: {
          request: {
            unknownContent: "error",
            unresolvedToolCall: "xrepair",
            localCacheControl: "ignore",
          },
          response: { unknownPiContent: "error" },
        },
      },
      "openai-responses": {
        stateFile: "state/openai-responses.json",
        conversion: {
          request: {
            privilegedMessages: "first",
            unknownInputItem: "error",
            orphanToolOutput: "error",
            unresolvedToolCall: "xrepair",
            futureReasoningEffort: "max",
          },
          response: {
            unknownPiContent: "error",
            storeFalse: "honor",
          },
        },
      },
    },
    diagnostics: {
      directory: "state/request-diagnostics",
      successArtifacts: { enabled: false },
      maxJourneyArtifactBytes: 4194304,
      artifactRetentionAgeMs: 604800000,
      maxArtifactJourneys: 1000,
    },
    pi: {
      directory: "pi",
    },
    limits: {
      maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
      requestTimeoutMs: 120000,
    },
  };
}

/** Creates the first-run config at `configPath` when the file does not
 *  exist. Returns true when the template was written, false when the file
 *  already existed (including deliberately incompatible content). */
export async function createFirstRunConfig(configPath: string): Promise<boolean> {
  await mkdir(dirname(configPath), { recursive: true });
  try {
    await writeFile(
      configPath,
      `${JSON.stringify(firstRunConfig(), null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: CONFIG_FILE_MODE },
    );
    await chmod(configPath, CONFIG_FILE_MODE);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : undefined;
    if (code === "EEXIST") return false;
    throw error;
  }
}
