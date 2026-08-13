export interface OpenAIResponsesConfiguration {
  readonly conversion: {
    readonly request: {
      readonly privilegedMessages: "full" | "first" | "user";
      readonly unknownInputItem: "error" | "ignore";
      readonly orphanToolOutput: "error" | "ignore";
      readonly unresolvedToolCall: "error" | "xrepair";
      readonly futureReasoningEffort: "max" | "omit" | "error";
    };
    readonly response: {
      readonly unknownPiContent: "error" | "ignore";
      readonly storeFalse: "honor" | "memory" | "persist";
    };
  };
}
const snapshots = new WeakSet<object>();
function record(value: unknown, path: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key} is unknown`); }
function choice<T extends string>(value: unknown, fallback: T, allowed: readonly T[], path: string): T { if (value === undefined) return fallback; if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${path} must be one of: ${allowed.join(", ")}`); return value as T; }
export function parseOpenAIResponsesConfiguration(value: unknown = {}, path = "clientProtocols.openai-responses"): OpenAIResponsesConfiguration {
  const root=record(value,path); keys(root,["conversion"],path); const conversion=record(root.conversion===undefined?{}:root.conversion,`${path}.conversion`); keys(conversion,["request","response"],`${path}.conversion`);
  const request=record(conversion.request===undefined?{}:conversion.request,`${path}.conversion.request`); keys(request,["privilegedMessages","unknownInputItem","orphanToolOutput","unresolvedToolCall","futureReasoningEffort"],`${path}.conversion.request`);
  const response=record(conversion.response===undefined?{}:conversion.response,`${path}.conversion.response`); keys(response,["unknownPiContent","storeFalse"],`${path}.conversion.response`);
  const snapshot = Object.freeze({conversion:Object.freeze({request:Object.freeze({
    privilegedMessages:choice(request.privilegedMessages,"first",["full","first","user"],`${path}.conversion.request.privilegedMessages`), unknownInputItem:choice(request.unknownInputItem,"error",["error","ignore"],`${path}.conversion.request.unknownInputItem`), orphanToolOutput:choice(request.orphanToolOutput,"error",["error","ignore"],`${path}.conversion.request.orphanToolOutput`), unresolvedToolCall:choice(request.unresolvedToolCall,"xrepair",["error","xrepair"],`${path}.conversion.request.unresolvedToolCall`), futureReasoningEffort:choice(request.futureReasoningEffort,"max",["max","omit","error"],`${path}.conversion.request.futureReasoningEffort`)}), response:Object.freeze({unknownPiContent:choice(response.unknownPiContent,"error",["error","ignore"],`${path}.conversion.response.unknownPiContent`),storeFalse:choice(response.storeFalse,"honor",["honor","memory","persist"],`${path}.conversion.response.storeFalse`)})})});
  snapshots.add(snapshot);
  return snapshot;
}

export function bindOpenAIResponsesConfiguration(value: unknown): OpenAIResponsesConfiguration {
  if (typeof value !== "object" || value === null || !snapshots.has(value)) throw new Error("clientProtocols.openai-responses configuration is not a Responses-owned snapshot");
  return value as OpenAIResponsesConfiguration;
}
