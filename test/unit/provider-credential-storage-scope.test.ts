import { describe, expect, it } from "vitest";

import {
  managedCredentialReference,
} from "../../src/credentials/profile-record-store.js";

describe("credential storage scope", () => {
  it("does not persist content identity in a managed CredentialReference", () => {
    expect(managedCredentialReference("fixture-provider", "credential-a"))
      .toEqual({
        owner: "managed",
        path: "fixture-provider/credential-a/credential.auth.json",
      });
  });

  it("rejects unsafe managed credential identifiers", () => {
    expect(() =>
      managedCredentialReference("fixture-provider", "../credential"),
    ).toThrow(/unsafe/iu);
  });
});
