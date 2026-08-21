import { describe, expect, it } from "vitest";

import { createConfigValueResolver } from "../../src/providers/config-value.js";

/**
 * Ticket 10 config-value resolution seam.
 *
 * Mirrors the pinned Pi implementation
 * (`pi-agent/packages/coding-agent/src/core/resolve-config-value.ts` in
 * `@earendil-works/pi-coding-agent` 0.84.2): literal values, `$VAR` /
 * `${VAR}` environment references, `$$`/`$!` escapes, and `!command` shell
 * commands, resolved UNCACHED at every request. Env and command sources are
 * injected adapters — the test suite never executes real shell commands.
 * Failure messages are bounded and secret-free: they never contain
 * environment-variable names or command text, even when those carry
 * credential canaries.
 */
describe("config value resolution", () => {
  function resolver(
    env: Readonly<Record<string, string>> = {},
    commands: Readonly<Record<string, string>> = {},
    runs: Array<{ command: string }> = [],
  ) {
    return {
      resolver: createConfigValueResolver({
        envSource: (name) => env[name],
        // The injected runner behaves like the pinned shell executor: it
        // trims stdout and reports empty output as unresolved.
        commandRunner: (command) => {
          runs.push({ command });
          const output = commands[command];
          return output === undefined ? undefined : output.trim() || undefined;
        },
      }),
      runs,
    };
  }

  it("passes literal values through unchanged", () => {
    const { resolver: r } = resolver();
    expect(r.resolveValueOrThrow("sk-literal-123", "API key for provider \"x\"")).toBe(
      "sk-literal-123",
    );
    expect(r.resolveValueOrThrow("a:b=c", "header value")).toBe("a:b=c");
  });

  it("interpolates $VAR and ${VAR} environment references from the injected env", () => {
    const { resolver: r } = resolver({ KEY: "sk-env-1", PREFIX: "pre" });
    expect(r.resolveValueOrThrow("$KEY", "key")).toBe("sk-env-1");
    expect(r.resolveValueOrThrow("${KEY}", "key")).toBe("sk-env-1");
    expect(r.resolveValueOrThrow("${PREFIX}-${KEY}", "key")).toBe("pre-sk-env-1");
    expect(r.resolveValueOrThrow("x$KEY", "key")).toBe("xsk-env-1");
  });

  it("supports $$ and $! escapes and treats invalid references as literals", () => {
    const { resolver: r } = resolver({ KEY: "sk-env-1" });
    expect(r.resolveValueOrThrow("$$KEY", "key")).toBe("$KEY");
    expect(r.resolveValueOrThrow("$!cmd", "key")).toBe("!cmd");
    expect(r.resolveValueOrThrow("${not valid}", "key")).toBe("${not valid}");
    expect(r.resolveValueOrThrow("$-", "key")).toBe("$-");
    expect(r.resolveValueOrThrow("${", "key")).toBe("${");
  });

  it("executes !command through the injected runner and trims output", () => {
    const { resolver: r, runs } = resolver({}, { "echo hi": "  hi  \n" });
    expect(r.resolveValueOrThrow("!echo hi", "key")).toBe("hi");
    expect(runs).toEqual([{ command: "echo hi" }]);
  });

  it("does not cache command or env results: every resolve re-reads the sources", () => {
    const env: Record<string, string> = { KEY: "v1" };
    const commands: Record<string, string> = { "cmd-one": "c1" };
    const { resolver: r, runs } = resolver(env, commands);
    expect(r.resolveValueOrThrow("$KEY", "key")).toBe("v1");
    expect(r.resolveValueOrThrow("!cmd-one", "key")).toBe("c1");
    env.KEY = "v2";
    commands["cmd-one"] = "c2";
    expect(r.resolveValueOrThrow("$KEY", "key")).toBe("v2");
    expect(r.resolveValueOrThrow("!cmd-one", "key")).toBe("c2");
    expect(runs).toEqual([{ command: "cmd-one" }, { command: "cmd-one" }]);
  });

  it("reports env var names for inspection without resolving values", () => {
    const { resolver: r } = resolver();
    expect(r.getEnvVarNames("$A-$B")).toEqual(["A", "B"]);
    expect(r.getEnvVarNames("${A}")).toEqual(["A"]);
    expect(r.getEnvVarNames("literal")).toEqual([]);
    expect(r.getEnvVarNames("!cmd $X")).toEqual([]);
    expect(r.isCommandConfigValue("!cmd")).toBe(true);
    expect(r.isCommandConfigValue("$X")).toBe(false);
    expect(r.isCommandConfigValue("plain")).toBe(false);
    expect(r.isConfigValueConfigured("$A", { A: "x" })).toBe(true);
    expect(r.isConfigValueConfigured("$A", {})).toBe(false);
    expect(r.isConfigValueConfigured("plain")).toBe(true);
  });

  it("fails with bounded secret-free messages when env references are missing", () => {
    const { resolver: r } = resolver();
    const error = (): string => {
      try {
        r.resolveValueOrThrow(
          "$CANARY_ENV_NAME_42",
          'API key for provider "anthropic"',
        );
        return "no error";
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    };
    expect(error()).toBe('Failed to resolve API key for provider "anthropic"');
    // The env var NAME (a credential canary here) must never appear.
    expect(error()).not.toContain("CANARY_ENV_NAME_42");
  });

  it("fails with bounded secret-free messages when commands fail", () => {
    const { resolver: r } = resolver({}, {});
    const error = (): string => {
      try {
        r.resolveValueOrThrow("!canary-command-text-77", "API key for provider \"x\"");
        return "no error";
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    };
    expect(error()).toBe('Failed to resolve API key for provider "x" from shell command');
    // The command text (a credential canary here) must never appear.
    expect(error()).not.toContain("canary-command-text-77");
  });

  it("fails when a command exits without output or an env template is empty", () => {
    const { resolver: r } = resolver({ EMPTY: "" }, { "no-output": "  \n" });
    expect(() => r.resolveValueOrThrow("!no-output", "key")).toThrow(
      'Failed to resolve key from shell command',
    );
    expect(() => r.resolveValueOrThrow("$EMPTY", "key")).toThrow(
      "Failed to resolve key",
    );
  });

  it("resolves header records per value and throws the same bounded errors", () => {
    const { resolver: r } = resolver({ H: "hv" });
    expect(r.resolveHeadersOrThrow({ "x-static": "v", "x-dyn": "$H" }, "provider \"p\"")).toEqual({
      "x-static": "v",
      "x-dyn": "hv",
    });
    expect(r.resolveHeadersOrThrow(undefined, "provider \"p\"")).toBeUndefined();
    expect(r.resolveHeadersOrThrow({}, "provider \"p\"")).toBeUndefined();
    const error = (): string => {
      try {
        r.resolveHeadersOrThrow(
          { "x-canary-header": "$CANARY_ENV_NAME_99" },
          'provider "p"',
        );
        return "no error";
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    };
    expect(error()).toBe('Failed to resolve provider "p" header "x-canary-header"');
    expect(error()).not.toContain("CANARY_ENV_NAME_99");
  });

  it("resolves explicit env records ahead of the injected source", () => {
    const { resolver: r } = resolver({ KEY: "source" });
    expect(r.resolveValueOrThrow("$KEY", "key", { KEY: "explicit" })).toBe("explicit");
    expect(r.resolveValueOrThrow("$ONLY_EXPLICIT", "key", { ONLY_EXPLICIT: "e" })).toBe("e");
  });
});
