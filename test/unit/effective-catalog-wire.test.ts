import { describe, expect, it } from "vitest";

import { decodeModelsFileState } from "../../packages/application-control-plane/src/wire.js";

function stateWithBaseline(version: string, schema: string) {
  return {
    revision: 1,
    path: "C:\\Token\\models.json",
    present: false,
    valid: true,
    raw: "",
    catalog: {
      schemaVersion: "token-effective-catalog-v1",
      baseline: {
        package: "@earendil-works/pi-coding-agent",
        version,
        schema,
      },
      providers: [],
      compositionErrors: [],
    },
  };
}

describe("effective catalog wire baseline", () => {
  it("rejects a Pi 0.84.1 catalog instead of retyping it as the current 0.84.2 contract", () => {
    expect(
      decodeModelsFileState(
        stateWithBaseline(
          "0.84.1",
          "pi-coding-agent-0.84.1-models-json-schema",
        ),
      ),
    ).toBeUndefined();
  });
});
