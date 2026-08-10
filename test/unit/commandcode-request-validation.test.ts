import { describe, expect, it } from "vitest";

import {
  validateCommandCodeRequest,
  type CommandCodeRequestAuthority,
} from "../../src/providers/commandcode-private/provider.js";
import type { ServerConfig } from "../../src/providers/commandcode-private/project.js";

const config: ServerConfig = {
  workingDir: "",
  date: "",
  environment: "",
  structure: [],
  isGitRepo: false,
  currentBranch: "",
  mainBranch: "",
  gitStatus: "",
  recentCommits: [],
};

const authority: CommandCodeRequestAuthority = {
  config,
  modelId: "model",
  modelAcceptsImages: false,
  permissionMode: "standard",
  sessionId: "00000000-0000-4000-8000-000000000081",
  supportedReasoningEfforts: new Set(["low", "medium", "high"]),
};

function validRequest(): Record<string, unknown> {
  return {
    config,
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    threadId: authority.sessionId,
    params: {
      model: "model",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call",
              toolName: "lookup",
              input: { q: "x" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "",
              output: { type: "text", value: "result" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          input_schema: { type: "object", properties: {} },
        },
      ],
      max_tokens: 10,
      stream: true,
      temperature: 0,
      reasoning_effort: "high",
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fixture record invariant");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("fixture array invariant");
  return value;
}

describe("final CommandCode request validation", () => {
  it("accepts a structurally complete request under captured authority", () => {
    expect(() => validateCommandCodeRequest(validRequest(), authority)).not.toThrow();
  });

  it.each([
    [
      "model authority",
      (body: Record<string, unknown>) => {
        record(body.params).model = "other";
      },
    ],
    [
      "missing tool coverage",
      (body: Record<string, unknown>) => {
        array(record(body.params).messages).pop();
      },
    ],
    [
      "non-object tool input",
      (body: Record<string, unknown>) => {
        const messages = array(record(body.params).messages);
        const content = array(record(messages[0]).content);
        record(content[0]).input = [];
      },
    ],
    [
      "unsupported reasoning effort",
      (body: Record<string, unknown>) => {
        record(body.params).reasoning_effort = "max";
      },
    ],
    [
      "project authority",
      (body: Record<string, unknown>) => {
        record(body.config).workingDir = "/other";
      },
    ],
  ])("rejects $name changes", (_name, mutate) => {
    const body = structuredClone(validRequest());
    mutate(body);
    expect(() => validateCommandCodeRequest(body, authority)).toThrow();
  });

  it("rechecks selected-model image capability", () => {
    const body = validRequest();
    record(body.params).messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            image: "data:image/png;base64,aQ==",
            mimeType: "image/png",
          },
        ],
      },
    ];
    expect(() => validateCommandCodeRequest(body, authority)).toThrow(
      "does not accept image",
    );
  });
});
