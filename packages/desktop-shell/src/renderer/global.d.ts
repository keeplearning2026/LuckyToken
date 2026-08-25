/// <reference types="vite/client" />

import type { TokenDesktopApi } from "../shared/desktop-api.js";

declare global {
  interface Window {
    readonly Token: TokenDesktopApi;
  }
}

export {};
