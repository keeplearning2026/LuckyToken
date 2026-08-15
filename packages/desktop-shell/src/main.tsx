import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { createWindowsShellHost } from "./shell-lifecycle.js";
import {
  createTauriDesktopRuntime,
  type NativeTauriBridge,
} from "./tauri-shell-runtime.js";
import "./styles.css";

const bridge: NativeTauriBridge = {
  invoke: (command) => invoke(command),
  listen: (event, listener) => listen(event, listener),
};
const controlPlane = createTauriDesktopRuntime(bridge);
const shell = createWindowsShellHost(controlPlane);

const root = document.getElementById("root");
if (root === null) throw new Error("LuckyToken desktop root is missing");

createRoot(root).render(
  <App shell={shell} retryConnection={() => controlPlane.retryControlPlane()} />,
);
