import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  codexCliInvocation,
  type CreateCodexNativeCatalogSourceOptions,
  discoverCodexCommands,
} from "./native-catalog-source.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1_024 * 1_024;
const VALIDATION_TIMEOUT_MS = 30_000;
const VALIDATION_PROMPT = "LuckyToken catalog validation";

export interface CodexCatalogValidator {
  validate(content: string): Promise<void>;
}

export type CreateCodexCatalogValidatorOptions =
  CreateCodexNativeCatalogSourceOptions;

function candidateSlugs(content: string): readonly string[] {
  const parsed = JSON.parse(content) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("models" in parsed) ||
    !Array.isArray(parsed.models)
  ) {
    throw new Error("LuckyToken Codex catalog must contain a models array");
  }
  const slugs = parsed.models.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !("slug" in entry) ||
      typeof entry.slug !== "string" ||
      entry.slug.length === 0
    ) {
      throw new Error("LuckyToken Codex catalog contains an invalid model slug");
    }
    return entry.slug;
  });
  if (new Set(slugs).size !== slugs.length) {
    throw new Error("LuckyToken Codex catalog contains duplicate model slugs");
  }
  return Object.freeze(slugs);
}

function parsedOutputSlugs(stdout: string): ReadonlySet<string> {
  const parsed = JSON.parse(stdout) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("models" in parsed) ||
    !Array.isArray(parsed.models)
  ) {
    throw new Error("Codex debug models returned an invalid document");
  }
  return new Set(
    parsed.models.flatMap((entry): string[] => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry) ||
        !("slug" in entry) ||
        typeof entry.slug !== "string"
      ) {
        return [];
      }
      return [entry.slug];
    }),
  );
}

function processFailure(stage: string, error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return `${stage} failed`;
  }
  const output =
    "stderr" in error && typeof error.stderr === "string" && error.stderr.trim().length > 0
      ? error.stderr
      : "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
  if (output.trim().length === 0) {
    const code = "code" in error ? String(error.code) : "unknown";
    return `${stage} failed with ${code}`;
  }
  const detail = output.trim().replace(/\s+/gu, " ").slice(-500);
  return `${stage} failed: ${detail}`;
}

async function runCodex(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const invocation = codexCliInvocation(command, args, platform, env);
  const result = await execFileAsync(invocation.file, [...invocation.args], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: VALIDATION_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    ...invocation.options,
  });
  return result.stdout;
}

/**
 * Validate candidate bytes with the installed Codex parser in a temporary
 * CODEX_HOME. The published catalog and the user's config remain untouched
 * until both the catalog and one routed model-visible prompt are accepted.
 */
export function createCodexCatalogValidator(
  options: CreateCodexCatalogValidatorOptions,
): CodexCatalogValidator {
  const platform = options.platform ?? process.platform;
  const baseEnv = options.env ?? process.env;
  const discover =
    options.discoverCommands ?? (() => discoverCodexCommands(options));

  return Object.freeze({
    async validate(content: string): Promise<void> {
      const expectedSlugs = candidateSlugs(content);
      const routedSlug = expectedSlugs.find((slug) => slug.includes("/"));
      if (routedSlug === undefined) {
        throw new Error("LuckyToken Codex catalog contains no routed model");
      }

      const probeHome = await mkdtemp(
        join(tmpdir(), "luckytoken-codex-catalog-validation-"),
      );
      try {
        const catalogPath = join(probeHome, "luckytoken-model-catalog.json");
        await writeFile(catalogPath, content, "utf8");
        await writeFile(
          join(probeHome, "config.toml"),
          [
            'model_provider = "openai"',
            'openai_base_url = "http://127.0.0.1:1/v1"',
            `model_catalog_json = ${JSON.stringify(catalogPath)}`,
            "",
          ].join("\n"),
          "utf8",
        );
        const env = { ...baseEnv, CODEX_HOME: probeHome };
        const commands = await discover();
        let lastFailure = "no Codex CLI command was discovered";
        for (const command of commands) {
          let stage = "debug models";
          try {
            const modelsOutput = await runCodex(
              command,
              ["debug", "models"],
              platform,
              env,
            );
            const actualSlugs = parsedOutputSlugs(modelsOutput);
            if (expectedSlugs.some((slug) => !actualSlugs.has(slug))) {
              throw new Error("Codex debug models omitted a candidate slug");
            }
            stage = "debug prompt-input";
            const promptOutput = await runCodex(
              command,
              [
                "-m",
                routedSlug,
                "debug",
                "prompt-input",
                VALIDATION_PROMPT,
              ],
              platform,
              env,
            );
            if (!promptOutput.includes(VALIDATION_PROMPT)) {
              throw new Error("Codex prompt omitted the validation input");
            }
            return;
          } catch (error) {
            const failure =
              error instanceof Error &&
              (error.message === "Codex debug models omitted a candidate slug" ||
                error.message === "Codex prompt omitted the validation input")
                ? error.message
                : processFailure(stage, error);
            lastFailure = failure;
            const unavailable =
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "EACCES");
            if (!unavailable) break;
            // Try the next installed runtime candidate.
          }
        }
        throw new Error(
          `No installed Codex CLI accepted the LuckyToken model catalog candidate: ${lastFailure}`,
        );
      } finally {
        await rm(probeHome, { recursive: true, force: true });
      }
    },
  });
}
