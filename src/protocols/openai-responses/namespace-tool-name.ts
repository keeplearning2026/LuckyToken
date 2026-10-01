/**
 * Canonical Responses identity for a tool declared inside a namespace.
 * Keep this in the protocol boundary so request conversion and compaction
 * rewriting use the same reversible name.
 */
export const NAMESPACE_SEPARATOR = "__";

export function flattenResponsesNamespaceToolName(
  namespace: string,
  child: string,
): string {
  return `${namespace}${NAMESPACE_SEPARATOR}${child}`;
}
