export type CodexFetchFunction = typeof globalThis.fetch;

/** Read-only Direct Mode model identity seam published by the Codex integration authority. */
export interface CodexNativeModelSource {
  has(modelId: string): boolean;
}
