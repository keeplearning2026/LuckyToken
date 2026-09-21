export type ResponsesToolChoice =
  | { readonly kind: "auto" | "none" | "required" }
  | {
      readonly kind: "named";
      readonly toolType: "function" | "custom";
      readonly name: string;
    }
  | {
      readonly kind: "hosted";
      readonly toolType: "apply_patch" | "shell" | "mcp";
      readonly name?: string;
      readonly serverLabel?: string;
    }
  | {
      readonly kind: "allowed";
      readonly mode: "auto" | "required";
      readonly tools: readonly ResponsesAllowedTool[];
    };

export type ResponsesAllowedTool =
  | {
      readonly toolType: "function" | "custom";
      readonly name: string;
    }
  | {
      readonly toolType: "apply_patch" | "shell";
    }
  | {
      readonly toolType: "mcp";
      readonly serverLabel: string;
      readonly name?: string;
    };

/** Client-wire tool choice retained only for the Responses response echo. */
export type ResponsesEchoToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      readonly type: "function" | "custom";
      readonly name: string;
    }
  | {
      readonly type: "allowed_tools";
      readonly mode: "auto" | "required";
      readonly tools: readonly Readonly<Record<string, unknown>>[];
    }
  | Readonly<Record<string, unknown>>;

export function toResponsesEchoToolChoice(
  choice: ResponsesToolChoice,
): ResponsesEchoToolChoice {
  if (
    choice.kind === "auto" ||
    choice.kind === "none" ||
    choice.kind === "required"
  ) {
    return choice.kind;
  }
  if (choice.kind === "named") {
    return Object.freeze({ type: choice.toolType, name: choice.name });
  }
  if (choice.kind === "allowed") {
    return Object.freeze({
      type: "allowed_tools",
      mode: choice.mode,
      tools: Object.freeze(
        choice.tools.map((tool) =>
          Object.freeze(
            tool.toolType === "function" || tool.toolType === "custom"
              ? { type: tool.toolType, name: tool.name }
              : tool.toolType === "mcp"
                ? {
                    type: "mcp",
                    server_label: tool.serverLabel,
                    ...(tool.name === undefined ? {} : { name: tool.name }),
                  }
                : { type: tool.toolType },
          ),
        ),
      ),
    });
  }
  if (choice.kind !== "hosted") return "auto";
  return Object.freeze(
    choice.toolType === "mcp"
      ? {
          type: "mcp",
          server_label: choice.serverLabel,
          ...(choice.name === undefined ? {} : { name: choice.name }),
        }
      : { type: choice.toolType },
  );
}
