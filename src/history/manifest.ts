/**
 * Versioned history export manifest (Ticket 23) — the on-disk artifact
 * contract. One file, one manifest version, per-authority sections.
 *
 * Artifact layout: an optional single leading marker line
 * (`# LUCKYSENSITIVE:1`) when the export contains sensitive capture, then
 * one JSON document:
 *
 * ```json
 * {
 *   "manifestVersion": 1,
 *   "exportedAt": <ms>,
 *   "application": { "id": "luckytoken", "version": "0.0.0" },
 *   "range": "all" | { "fromMs": N, "toMs": N },
 *   "redaction": { "policy": "universal" },
 *   "sensitive": false,
 *   "audit": { "unavailable": false },
 *   "sections": { "requestLedger": [...], "diagnostics": [...], "capture": [...] },
 *   "sources": {
 *     "requestLedger": { "schemaVersion": 2, "count": N },
 *     "diagnostics": { "schemaVersion": 1, "count": N },
 *     "capture": { "included": false, "reason": "excluded-by-default" }
 *   }
 * }
 * ```
 *
 * Consumers must skip a leading `#` line before parsing JSON. The marker
 * makes the sensitivity visible in any file viewer without parsing; the
 * `sensitive` field is the authoritative mark. Section arrays stream one
 * record per line (bounded memory); `sources` is the trailing footer so
 * counts are written after streaming completes.
 */
import type { HistoryRange } from "@luckytoken/application-control-plane/control-plane";

export const HISTORY_EXPORT_MANIFEST_VERSION = 1 as const;

/** First content byte of a sensitive export; also present in the manifest
 *  as `sensitive: true`. */
export const SENSITIVE_MARKER_LINE = "# LUCKYSENSITIVE:1";

export interface HistoryExportSourceFacts {
  readonly requestLedger: { readonly schemaVersion: number; readonly count: number };
  readonly diagnostics: { readonly schemaVersion: number; readonly count: number };
  readonly capture:
    | { readonly included: false; readonly reason: "excluded-by-default" }
    | { readonly included: true; readonly schemaVersion: number; readonly count: number };
}

export function serializeRange(range: HistoryRange): string {
  if (range === "all") return '"all"';
  return JSON.stringify({
    ...(range.fromMs === undefined ? {} : { fromMs: range.fromMs }),
    ...(range.toMs === undefined ? {} : { toMs: range.toMs }),
  });
}

/** The artifact's opening lines (before any section record). */
export function buildManifestHeader(options: {
  readonly exportedAt: number;
  readonly range: HistoryRange;
  readonly sensitive: boolean;
  readonly auditUnavailable: boolean;
  readonly applicationVersion: string;
}): string {
  return [
    ...(options.sensitive ? [SENSITIVE_MARKER_LINE] : []),
    "{",
    `  "manifestVersion": ${HISTORY_EXPORT_MANIFEST_VERSION},`,
    `  "exportedAt": ${options.exportedAt},`,
    `  "application": ${JSON.stringify({
      id: "luckytoken",
      version: options.applicationVersion,
    })},`,
    `  "range": ${serializeRange(options.range)},`,
    `  "redaction": ${JSON.stringify({ policy: "universal" })},`,
    `  "sensitive": ${options.sensitive ? "true" : "false"},`,
    `  "audit": ${JSON.stringify({ unavailable: options.auditUnavailable })},`,
    '  "sections": {',
  ].join("\n");
}

/** The artifact's trailing footer (after the last section array). */
export function buildManifestFooter(sources: HistoryExportSourceFacts): string {
  const lines = [
    "  },",
    '  "sources": {',
    `    "requestLedger": ${JSON.stringify(sources.requestLedger)},`,
    `    "diagnostics": ${JSON.stringify(sources.diagnostics)},`,
    `    "capture": ${JSON.stringify(sources.capture)}`,
    "  }",
    "}",
  ];
  return lines.join("\n");
}
