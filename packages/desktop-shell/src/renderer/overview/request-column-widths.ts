export type RequestColumnId =
  | "startTime"
  | "session"
  | "requestId"
  | "protocol"
  | "input"
  | "cacheRead"
  | "hit"
  | "output"
  | "tokenSpeed"
  | "time"
  | "model"
  | "status";

export interface RequestColumnDefinition {
  readonly id: RequestColumnId;
  readonly label: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
}

export const REQUEST_COLUMN_DEFINITIONS: readonly RequestColumnDefinition[] = [
  { id: "startTime", label: "Start time", defaultWidth: 224, minWidth: 168, maxWidth: 360 },
  { id: "session", label: "Session", defaultWidth: 112, minWidth: 84, maxWidth: 240 },
  { id: "requestId", label: "Request ID", defaultWidth: 112, minWidth: 84, maxWidth: 240 },
  { id: "protocol", label: "Protocol", defaultWidth: 170, minWidth: 128, maxWidth: 300 },
  { id: "input", label: "Input", defaultWidth: 84, minWidth: 68, maxWidth: 160 },
  { id: "cacheRead", label: "Cache read", defaultWidth: 108, minWidth: 88, maxWidth: 190 },
  { id: "hit", label: "Hit", defaultWidth: 78, minWidth: 64, maxWidth: 150 },
  { id: "output", label: "Output", defaultWidth: 88, minWidth: 68, maxWidth: 160 },
  { id: "tokenSpeed", label: "Token speed", defaultWidth: 148, minWidth: 116, maxWidth: 250 },
  { id: "time", label: "Time", defaultWidth: 88, minWidth: 70, maxWidth: 160 },
  { id: "model", label: "Model", defaultWidth: 180, minWidth: 130, maxWidth: 380 },
  { id: "status", label: "Status", defaultWidth: 128, minWidth: 100, maxWidth: 240 },
];

export type RequestColumnWidths = Readonly<Record<RequestColumnId, number>>;

export const REQUEST_COLUMN_WIDTHS_STORAGE_KEY =
  "Token.overview.request-column-widths.v1";

export const DEFAULT_REQUEST_COLUMN_WIDTHS: RequestColumnWidths = Object.fromEntries(
  REQUEST_COLUMN_DEFINITIONS.map((column) => [column.id, column.defaultWidth]),
) as unknown as RequestColumnWidths;

const definitionsById = new Map(
  REQUEST_COLUMN_DEFINITIONS.map((column) => [column.id, column]),
);

export function clampRequestColumnWidth(id: RequestColumnId, width: number): number {
  const definition = definitionsById.get(id);
  if (definition === undefined) return width;
  return Math.min(definition.maxWidth, Math.max(definition.minWidth, Math.round(width)));
}

export function getRequestColumnStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadRequestColumnWidths(
  storage: Pick<Storage, "getItem"> | undefined,
): RequestColumnWidths {
  const defaults = { ...DEFAULT_REQUEST_COLUMN_WIDTHS };
  if (storage === undefined) return defaults;
  try {
    const serialized = storage.getItem(REQUEST_COLUMN_WIDTHS_STORAGE_KEY);
    if (serialized === null) return defaults;
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return defaults;
    for (const definition of REQUEST_COLUMN_DEFINITIONS) {
      const value = (parsed as Record<string, unknown>)[definition.id];
      if (typeof value === "number" && Number.isFinite(value)) {
        defaults[definition.id] = clampRequestColumnWidth(definition.id, value);
      }
    }
    return defaults;
  } catch {
    return defaults;
  }
}

export function saveRequestColumnWidths(
  storage: Pick<Storage, "setItem"> | undefined,
  widths: RequestColumnWidths,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(REQUEST_COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // UI preferences must never interrupt request monitoring.
  }
}

export function totalRequestColumnWidth(widths: RequestColumnWidths): number {
  return REQUEST_COLUMN_DEFINITIONS.reduce((total, column) => total + widths[column.id], 0);
}
