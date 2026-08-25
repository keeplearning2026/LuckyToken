import { describe, expect, it } from "vitest";

import { validateExportDestination } from "../../src/history/index.js";

/**
 * Ticket 23 export destination validation matrix (pure, deterministic):
 * absolute-only, control-char rejection, Windows reserved device names,
 * Token-owned-root rejection, and the parent-directory creation rule.
 */

const OWNED_ROOTS = ["C:\\Users\\fixture\\.Token", "C:\\ProgramData\\Token"];

describe("history export destination validation (Ticket 23)", () => {
  it("accepts canonical absolute paths outside owned roots", () => {
    expect(
      validateExportDestination(
        "C:\\Users\\fixture\\Documents\\exports\\history.json",
        OWNED_ROOTS,
      ),
    ).toEqual({ ok: true });
    expect(
      validateExportDestination(
        "D:\\exports\\history.json",
        OWNED_ROOTS,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects relative and empty paths", () => {
    expect(
      validateExportDestination("relative/path.json", OWNED_ROOTS).ok,
    ).toBe(false);
    expect(validateExportDestination("", OWNED_ROOTS).ok).toBe(false);
    expect(
      validateExportDestination(".\\relative.json", OWNED_ROOTS).ok,
    ).toBe(false);
  });

  it("rejects control characters and NUL", () => {
    expect(
      validateExportDestination("C:\\exports\\bad\u0000name.json", OWNED_ROOTS)
        .ok,
    ).toBe(false);
    expect(
      validateExportDestination("C:\\exports\\bad\u0007name.json", OWNED_ROOTS)
        .ok,
    ).toBe(false);
  });

  it("rejects Windows reserved device basenames (any case, with or without extension)", () => {
    for (const name of [
      "CON",
      "con",
      "Prn",
      "AUX",
      "NUL",
      "COM1",
      "COM9",
      "LPT1",
      "LPT9",
      "CON.txt",
      "nul.json",
    ]) {
      expect(
        validateExportDestination(`C:\\exports\\${name}`, OWNED_ROOTS).ok,
      ).toBe(false);
    }
    // Benign names with the same letters are fine.
    expect(
      validateExportDestination("C:\\exports\\console.json", OWNED_ROOTS).ok,
    ).toBe(true);
    expect(
      validateExportDestination("C:\\exports\\comb.json", OWNED_ROOTS).ok,
    ).toBe(true);
  });

  it("rejects destinations inside Token-owned directory trees", () => {
    for (const path of [
      "C:\\Users\\fixture\\.Token\\settings.json",
      "C:\\Users\\fixture\\.Token\\state\\pi\\models.json",
      "C:\\Users\\fixture\\.Token\\client-auth\\token.json",
      "C:\\ProgramData\\Token\\anything.json",
    ]) {
      expect(validateExportDestination(path, OWNED_ROOTS).ok).toBe(false);
    }
    // A sibling directory is not owned.
    expect(
      validateExportDestination(
        "C:\\Users\\fixture\\.token-backup\\export.json",
        OWNED_ROOTS,
      ).ok,
    ).toBe(true);
  });

  it("treats Windows path casing aliases as the same owned directory", () => {
    expect(
      validateExportDestination(
        "c:\\users\\FIXTURE\\.Token\\history.json",
        OWNED_ROOTS,
      ),
    ).toEqual({ ok: false, code: "invalid_destination" });
  });
});
