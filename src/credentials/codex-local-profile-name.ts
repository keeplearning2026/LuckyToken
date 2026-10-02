/** Token-owned display suffix for the Profile imported from the local Codex login. */
const CODEX_LOCAL_PROFILE_SUFFIX = " (LOCAL CODEX)";

/** Append the Token-owned suffix to a validated, non-empty Profile name base. */
export function codexLocalProfileDisplayName(base: string): string {
  const normalized = base.trim();
  if (normalized.length === 0) {
    throw new Error("LOCAL CODEX Profile names require a non-empty base");
  }
  return `${normalized}${CODEX_LOCAL_PROFILE_SUFFIX}`;
}
