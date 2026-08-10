import type { Tool } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { convertCommandCodeTools } from "../../src/providers/commandcode-private/provider.js";

describe("CommandCode Pi tool definitions", () => {
  it("emits only exact name, description, and the complete input schema", () => {
    const parameters = {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    };
    const tools: Tool[] = [
      {
        name: "lookup",
        description: "Exact description",
        parameters,
      },
      {
        name: "preferred",
        description: "",
        parameters: { type: "object", properties: {} },
        constrainedSampling: { type: "json_schema", strict: "prefer" },
      },
    ];

    expect(convertCommandCodeTools(tools)).toEqual([
      { name: "lookup", description: "Exact description", input_schema: parameters },
      {
        name: "preferred",
        description: "",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("fails instead of downgrading required JSON-schema enforcement", () => {
    expect(() =>
      convertCommandCodeTools([
        {
          name: "strict",
          description: "",
          parameters: { type: "object", properties: {} },
          constrainedSampling: { type: "json_schema", strict: "require" },
        },
      ]),
    ).toThrow("required JSON-schema constrained sampling");
  });
});
