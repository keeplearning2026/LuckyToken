import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./renderer.css";

function DesktopSkeleton() {
  return (
    <main className="desktop-skeleton">
      <p className="eyebrow">LUCKYTOKEN</p>
      <h1>Desktop shell ready</h1>
      <p>Electron security and lifecycle foundations are active.</p>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("LuckyToken desktop root is missing");

createRoot(root).render(
  <StrictMode>
    <DesktopSkeleton />
  </StrictMode>,
);
