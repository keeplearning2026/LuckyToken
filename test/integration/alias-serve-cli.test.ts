import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

interface ChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function captureChild(child: ChildProcessWithoutNullStreams): {
  readonly result: Promise<ChildResult>;
} {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const result = new Promise<ChildResult>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { result };
}

function startCli(args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [tsxCli, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: "pipe",
  });
}

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as { readonly port: number };
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Ticket 14 serve wiring seam: the running LuckyToken instance owns the
 * transparent model-aliases.json next to models.json and serves the
 * versioned alias commands through the Control Plane. The CLI `control
 * aliases` commands drive the real serve process end to end.
 */
describe("alias serve wiring", () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      children.splice(0).map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill();
        });
      }),
    );
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  it(
    "serves alias queries and compare-and-swap writes through the running instance",
    { timeout: 60_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "luckytoken-alias-serve-"));
      roots.push(root);
      const stateDirectory = join(root, "state");
      await mkdir(stateDirectory, { recursive: true });
      const configPath = join(root, "luckytoken.config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          schemaVersion: "luckytoken-config-v1",
          server: { host: "127.0.0.1", port: await reserveFreePort() },
          clientProtocols: {
            "anthropic-messages": {
              authFile: "client-auth/anthropic-messages.json",
            },
          },
          pi: { directory: "pi" },
        }),
        "utf8",
      );
      const descriptorPath = join(stateDirectory, "control-plane.json");
      const serve = startCli([
        "--config",
        configPath,
        "--descriptor",
        descriptorPath,
      ]);
      children.push(serve);
      const serveCapture = captureChild(serve);

      await expect
        .poll(async () => {
          try {
            const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as {
              address?: unknown;
              capability?: unknown;
            };
            return (
              typeof parsed.address === "string" &&
              typeof parsed.capability === "string"
            );
          } catch {
            return false;
          }
        }, { timeout: 10_000, interval: 50 })
        .toBe(true);

      await expect
        .poll(async () => {
          const status = startCli([
            "control",
            "status",
            "--descriptor",
            descriptorPath,
          ]);
          children.push(status);
          const result = await captureChild(status).result;
          if (result.code !== 0) return false;
          const parsed = JSON.parse(result.stdout) as { modelDataPlane: string };
          return parsed.modelDataPlane === "running";
        }, { timeout: 10_000, interval: 50 })
        .toBe(true);

      // Query: the authoritative state with the curated defaults effective
      // and the transparent file location.
      const query = startCli([
        "control",
        "aliases",
        "query",
        "--descriptor",
        descriptorPath,
      ]);
      children.push(query);
      const queryResult = await captureChild(query).result;
      expect(queryResult.code).toBe(0);
      const queried = JSON.parse(queryResult.stdout) as {
        outcome: string;
        state: {
          revision: number;
          path: string;
          present: boolean;
          valid: boolean;
          defaultsVersion: number;
          effective?: { aliases: readonly unknown[] };
        };
      };
      expect(queried.outcome).toBe("ok");
      expect(queried.state.revision).toBe(0);
      expect(queried.state.present).toBe(false);
      expect(queried.state.path).toBe(join(root, "model-aliases.json"));
      expect(queried.state.defaultsVersion).toBe(2);
      expect((queried.state.effective?.aliases.length ?? 0)).toBeGreaterThan(0);

      // Write a valid user mapping (compare-and-swap on revision 0).
      const aliasesFile = join(root, "aliases-proposal.json");
      await writeFile(
        aliasesFile,
        `${JSON.stringify({ aliases: { "my-model": { provider: "openai", model: "gpt-4o" } } }, null, 2)}\n`,
        "utf8",
      );
      const write = startCli([
        "control",
        "aliases",
        "write",
        "0",
        aliasesFile,
        "--descriptor",
        descriptorPath,
      ]);
      children.push(write);
      const writeResult = await captureChild(write).result;
      expect(writeResult.code).toBe(0);
      const written = JSON.parse(writeResult.stdout) as {
        outcome: string;
        state: { revision: number; present: boolean; valid: boolean };
      };
      expect(written.outcome).toBe("ok");
      expect(written.state.revision).toBe(1);
      expect(written.state.present).toBe(true);
      expect(written.state.valid).toBe(true);

      // The file is the transparent authority: byte-exact LuckyToken shape.
      const onDisk = JSON.parse(await readFile(join(root, "model-aliases.json"), "utf8")) as {
        aliases: Record<string, unknown>;
      };
      expect(onDisk.aliases).toEqual({
        "my-model": { provider: "openai", model: "gpt-4o" },
      });

      // A rejected proposal (unknown target) never replaces the registry.
      const rejectedFile = join(root, "aliases-rejected.json");
      await writeFile(
        rejectedFile,
        `${JSON.stringify({ aliases: { "ghost": { provider: "openai", model: "missing" } } })}\n`,
        "utf8",
      );
      const rejected = startCli([
        "control",
        "aliases",
        "write",
        "1",
        rejectedFile,
        "--descriptor",
        descriptorPath,
      ]);
      children.push(rejected);
      const rejectedResult = await captureChild(rejected).result;
      expect(rejectedResult.code).toBe(0);
      const rejectedOutcome = JSON.parse(rejectedResult.stdout) as {
        outcome: string;
        state: { revision: number };
        error?: { kind: string; entries?: readonly { alias: string; code: string }[] };
      };
      expect(rejectedOutcome.outcome).toBe("invalid");
      expect(rejectedOutcome.error?.kind).toBe("validation");
      expect(rejectedOutcome.error?.entries).toEqual([
        expect.objectContaining({ alias: "ghost", code: "unknown" }),
      ]);
      expect(rejectedOutcome.state.revision).toBe(1);

      // A stale revision is a conflict.
      const conflict = startCli([
        "control",
        "aliases",
        "write",
        "0",
        aliasesFile,
        "--descriptor",
        descriptorPath,
      ]);
      children.push(conflict);
      const conflictResult = await captureChild(conflict).result;
      expect(conflictResult.code).toBe(0);
      const conflicted = JSON.parse(conflictResult.stdout) as { outcome: string };
      expect(conflicted.outcome).toBe("conflict");

      // A proposal with the models.json comment syntax is accepted (the
      // authority parses the same JSON-with-comments flavor).
      const commentedFile = join(root, "aliases-commented.json");
      await writeFile(
        commentedFile,
        `{\n  // user note kept in the proposal\n  \"aliases\": {\n    \"commented\": { \"provider\": \"openai\", \"model\": \"gpt-4o\" },\n  },\n}\n`,
        "utf8",
      );
      const commented = startCli([
        "control",
        "aliases",
        "write",
        "1",
        commentedFile,
        "--descriptor",
        descriptorPath,
      ]);
      children.push(commented);
      const commentedResult = await captureChild(commented).result;
      expect(commentedResult.code).toBe(0);
      const commentedOutcome = JSON.parse(commentedResult.stdout) as {
        outcome: string;
        state: { revision: number };
      };
      expect(commentedOutcome.outcome).toBe("ok");
      expect(commentedOutcome.state.revision).toBe(2);

      // A malformed proposal is rejected before the write: no guessed empty
      // mapping is invented, the command fails value-safely and the
      // authoritative file bytes stay untouched.
      const registryPath = join(root, "model-aliases.json");
      const registryBytes = await readFile(registryPath);
      const malformedProposals: ReadonlyArray<{
        readonly name: string;
        readonly content: string;
        readonly message: string;
      }> = [
        {
          name: "missing-aliases",
          content: "{}\n",
          message: "must contain an aliases object",
        },
        {
          name: "null-aliases",
          content: JSON.stringify({ aliases: null }),
          message: "must contain an aliases object",
        },
        {
          name: "array-aliases",
          content: JSON.stringify({ aliases: ["openai/gpt-4o"] }),
          message: "must contain an aliases object",
        },
        {
          name: "array-root",
          content: JSON.stringify([{ aliases: {} }]),
          message: "must be a JSON object",
        },
        {
          name: "unparsable",
          content: `{ "aliases": `,
          message: "is not a valid proposal",
        },
      ];
      for (const proposal of malformedProposals) {
        const proposalPath = join(root, `aliases-${proposal.name}.json`);
        await writeFile(proposalPath, proposal.content, "utf8");
        const attempt = startCli([
          "control",
          "aliases",
          "write",
          "2",
          proposalPath,
          "--descriptor",
          descriptorPath,
        ]);
        children.push(attempt);
        const attemptResult = await captureChild(attempt).result;
        expect(attemptResult.code).not.toBe(0);
        expect(attemptResult.stdout).toBe("");
        expect(attemptResult.stderr).toContain(proposal.message);
        expect(await readFile(registryPath)).toEqual(registryBytes);
      }

      // The registry was never replaced by a guessed default: the last
      // successful user mapping and revision survive every malformed write.
      const afterMalformed = startCli([
        "control",
        "aliases",
        "query",
        "--descriptor",
        descriptorPath,
      ]);
      children.push(afterMalformed);
      const afterMalformedResult = await captureChild(afterMalformed).result;
      expect(afterMalformedResult.code).toBe(0);
      const afterMalformedQuery = JSON.parse(afterMalformedResult.stdout) as {
        outcome: string;
        state: { revision: number; aliases?: Record<string, unknown> };
      };
      expect(afterMalformedQuery.outcome).toBe("ok");
      expect(afterMalformedQuery.state.revision).toBe(2);
      // A write replaces the user record as a whole: the malformed attempts
      // must not have wiped or altered the last successful mapping.
      expect(afterMalformedQuery.state.aliases).toEqual({
        commented: { provider: "openai", model: "gpt-4o" },
      });

      // The sanitized projection rides on status snapshots.
      const status = startCli([
        "control",
        "status",
        "--descriptor",
        descriptorPath,
      ]);
      children.push(status);
      const statusResult = await captureChild(status).result;
      expect(statusResult.code).toBe(0);
      const statusSnapshot = JSON.parse(statusResult.stdout) as {
        aliases?: { revision: number; present: boolean; valid: boolean };
      };
      expect(statusSnapshot.aliases?.revision).toBe(2);
      expect(statusSnapshot.aliases?.present).toBe(true);
      expect(statusSnapshot.aliases?.valid).toBe(true);

      expect(serveCapture).toBeDefined();
      serve.kill();
    },
  );
});
