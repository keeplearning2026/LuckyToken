import type { LuckyTokenDesktopApi } from "../shared/desktop-api.js";

declare global {
  interface Window {
    readonly luckytoken: LuckyTokenDesktopApi;
  }
}

export {};
