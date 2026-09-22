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
