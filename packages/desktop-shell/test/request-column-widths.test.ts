import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REQUEST_COLUMN_WIDTHS,
  loadRequestColumnWidths,
  REQUEST_COLUMN_WIDTHS_STORAGE_KEY,
  saveRequestColumnWidths,
} from "../src/renderer/overview/request-column-widths.js";

describe("request column width preferences", () => {
  it("falls back safely and clamps persisted widths to each column contract", () => {
    expect(loadRequestColumnWidths(undefined)).toEqual(DEFAULT_REQUEST_COLUMN_WIDTHS);
    expect(loadRequestColumnWidths({ getItem: () => "not-json" })).toEqual(
      DEFAULT_REQUEST_COLUMN_WIDTHS,
    );

    const widths = loadRequestColumnWidths({
      getItem: () => JSON.stringify({ startTime: 10, model: 9_999, status: 176, unknown: 500 }),
    });
    expect(widths.startTime).toBe(168);
    expect(widths.model).toBe(380);
    expect(widths.status).toBe(176);
    expect(widths.session).toBe(DEFAULT_REQUEST_COLUMN_WIDTHS.session);
  });

  it("round-trips the renderer preference through versioned storage", () => {
    let serialized: string | null = null;
    const storage = {
      getItem: vi.fn(() => serialized),
      setItem: vi.fn((_key: string, value: string) => {
        serialized = value;
      }),
    };
    const changed = { ...DEFAULT_REQUEST_COLUMN_WIDTHS, protocol: 236, output: 124 };

    saveRequestColumnWidths(storage, changed);

    expect(storage.setItem).toHaveBeenCalledWith(
      REQUEST_COLUMN_WIDTHS_STORAGE_KEY,
      JSON.stringify(changed),
    );
    expect(loadRequestColumnWidths(storage)).toEqual(changed);
  });
});
