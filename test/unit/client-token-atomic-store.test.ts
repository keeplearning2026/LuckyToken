import { describe, expect, it } from "vitest";

import * as publicApi from "../../src/index.js";

describe("removed Client Token public surface", () => {
  it("exports no Client Auth or Client Token store authority", () => {
    expect(publicApi).not.toHaveProperty("createAuth");
    expect(publicApi).not.toHaveProperty("createFileClientTokenStore");
    expect(publicApi).not.toHaveProperty("loadFileClientTokenAuthority");
    expect(publicApi).not.toHaveProperty("createLiveClientTokenAuthority");
  });
});
