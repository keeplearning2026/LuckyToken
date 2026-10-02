import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  externalCredentialReference,
  managedCredentialReference,
} from "../../src/credentials/profile-record-store.js";

describe("credential reference ownership", () => {
  it("uses stable relative managed paths and absolute external paths", () => {
    expect(managedCredentialReference("anthropic", "credential-a")).toEqual({
      owner: "managed",
      path: "anthropic/credential-a/credential.auth.json",
    });

    const externalPath = resolve("auth.json");
    expect(externalCredentialReference(externalPath)).toEqual({
      owner: "external",
      path: externalPath,
    });
  });
});
