import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bindRequestLedgerConfiguration,
  parseRequestLedgerConfiguration,
} from "../../src/request-ledger/index.js";

describe("Request Ledger configuration", () => {
  it("defaults the ledger directory under the config directory", () => {
    const root = resolve("config-root");
    const configuration = parseRequestLedgerConfiguration(undefined, root);
    expect(configuration.directory).toBe(
      resolve(root, "state", "request-ledger"),
    );
  });

  it("resolves relative and absolute directories and accepts only ledger-owned snapshots", () => {
    const root = resolve("config-root");
    expect(
      parseRequestLedgerConfiguration({ directory: "ledger" }, root).directory,
    ).toBe(resolve(root, "ledger"));
    const absolute = "D:\\ledger-root";
    const configuration = parseRequestLedgerConfiguration(
      { directory: absolute },
      root,
    );
    expect(configuration.directory).toBe(resolve(absolute));
    expect(bindRequestLedgerConfiguration(configuration)).toBe(configuration);
  });

  it("rejects unknown keys, empty directories, and foreign snapshots", () => {
    expect(() =>
      parseRequestLedgerConfiguration({ directory: "x", extra: true }, "root"),
    ).toThrow(/unknown/iu);
    expect(() =>
      parseRequestLedgerConfiguration({ directory: "  " }, "root"),
    ).toThrow(/non-empty string/iu);
    expect(() =>
      bindRequestLedgerConfiguration({ directory: "state/request-ledger" }),
    ).toThrow(/ledger-owned snapshot/iu);
  });
});