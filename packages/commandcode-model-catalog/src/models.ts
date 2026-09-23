export type CommandCodePlan = "go" | "goat" | "pro" | "max";

export type CommandCodeModelApi =
  | "openai-responses"
  | "openai-completions"
  | "anthropic-messages";

export type CommandCodeSupportedEndpoint =
  | "/messages"
  | "/chat/completions"
  | "/responses";

export type CommandCodeReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const COMMANDCODE_REASONING_EFFORTS = new Set<CommandCodeReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function isCommandCodeReasoningEffort(
  value: unknown,
): value is CommandCodeReasoningEffort {
  return (
    typeof value === "string" &&
    COMMANDCODE_REASONING_EFFORTS.has(value as CommandCodeReasoningEffort)
  );
}

export type CommandCodeThinkingLevel =
  | "off"
  | "minimal"
  | CommandCodeReasoningEffort;

export type CommandCodeThinkingLevelMap = Readonly<
  Record<CommandCodeThinkingLevel, CommandCodeReasoningEffort | null>
>;

export interface CommandCodeModelFacts {
  readonly id: string;
  readonly supportedEndpoints: readonly CommandCodeSupportedEndpoint[];
  readonly name: string;
  readonly description: string;
  readonly input: readonly ("text" | "image")[];
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: CommandCodeThinkingLevelMap;
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
  readonly minimumPlan: CommandCodePlan;
}

export function freezeCommandCodeModelFacts(
  values: readonly CommandCodeModelFacts[],
): readonly CommandCodeModelFacts[] {
  const ids = new Set<string>();
  return Object.freeze(
    values.map((value) => {
      if (value.id.length === 0 || ids.has(value.id)) {
        throw new Error(`CommandCode model id must be non-empty and unique: ${value.id}`);
      }
      ids.add(value.id);
      if (value.name.length === 0 || value.description.length === 0) {
        throw new Error(`CommandCode model ${value.id} must have a name and description`);
      }
      if (
        value.supportedEndpoints.length === 0 ||
        new Set(value.supportedEndpoints).size !== value.supportedEndpoints.length
      ) {
        throw new Error(
          `CommandCode model ${value.id} must have unique supportedEndpoints`,
        );
      }
      const endpoints = new Set(value.supportedEndpoints);
      if (
        [...endpoints].some(
          (endpoint) =>
            endpoint !== "/messages" &&
            endpoint !== "/chat/completions" &&
            endpoint !== "/responses",
        ) ||
        (endpoints.has("/messages") && endpoints.size !== 1) ||
        (!endpoints.has("/messages") &&
          !endpoints.has("/chat/completions") &&
          !endpoints.has("/responses"))
      ) {
        throw new Error(
          `CommandCode model ${value.id} has unsupported supportedEndpoints`,
        );
      }
      if (value.input.length === 0 || new Set(value.input).size !== value.input.length) {
        throw new Error(`CommandCode model ${value.id} must have unique input modalities`);
      }
      if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0) {
        throw new Error(`CommandCode model ${value.id} must have a positive context window`);
      }
      if (
        value.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens <= 0)
      ) {
        throw new Error(`CommandCode model ${value.id} must have a positive max output`);
      }
      if (!value.reasoning && value.thinkingLevelMap !== undefined) {
        throw new Error(`CommandCode model ${value.id} cannot declare levels without reasoning`);
      }
      if (value.reasoning && value.thinkingLevelMap === undefined) {
        throw new Error(`CommandCode reasoning model ${value.id} requires an explicit level map`);
      }
      let thinkingLevelMap: CommandCodeThinkingLevelMap | undefined;
      if (value.thinkingLevelMap !== undefined) {
        const keys = Object.keys(value.thinkingLevelMap);
        if (
          keys.join(",") !== "off,minimal,low,medium,high,xhigh,max" ||
          value.thinkingLevelMap.off !== null ||
          Object.values(value.thinkingLevelMap).some(
            (mapped) =>
              mapped !== null && !isCommandCodeReasoningEffort(mapped),
          )
        ) {
          throw new Error(`CommandCode model ${value.id} has an invalid level map`);
        }
        thinkingLevelMap = Object.freeze({ ...value.thinkingLevelMap });
      }
      return Object.freeze({
        ...value,
        supportedEndpoints: Object.freeze([...value.supportedEndpoints]),
        input: Object.freeze([...value.input]),
        ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
      });
    }),
  );
}

export function selectCommandCodeModelApi(
  facts: Pick<CommandCodeModelFacts, "supportedEndpoints">,
): CommandCodeModelApi {
  const endpoints = new Set(facts.supportedEndpoints);
  if (endpoints.has("/messages")) {
    if (endpoints.size !== 1) {
      throw new Error(
        "CommandCode supportedEndpoints cannot combine /messages with another endpoint",
      );
    }
    return "anthropic-messages";
  }
  if (endpoints.has("/responses")) return "openai-responses";
  if (endpoints.has("/chat/completions")) return "openai-completions";
  throw new Error("CommandCode supportedEndpoints do not select a Pi API");
}
