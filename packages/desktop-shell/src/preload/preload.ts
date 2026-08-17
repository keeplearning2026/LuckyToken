import { contextBridge } from "electron";

import type { LuckyTokenDesktopApi } from "../shared/desktop-api.js";

const api: LuckyTokenDesktopApi = Object.freeze({
  contractVersion: 1,
});

contextBridge.exposeInMainWorld("luckytoken", api);
