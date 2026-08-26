export type CodexDirectFetch = typeof globalThis.fetch;

/** Read-only Direct Mode model identity seam published by the Codex integration authority. */
export interface CodexDirectModelSource {
  has(modelId: string): boolean;
}
