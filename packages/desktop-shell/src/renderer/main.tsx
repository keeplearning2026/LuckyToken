import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App.js";
import "./renderer.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Token desktop root is missing");

createRoot(root).render(
  <StrictMode>
    <App api={window.luckytoken} />
  </StrictMode>,
);
