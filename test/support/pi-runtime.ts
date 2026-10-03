import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
  readonly packages: Readonly<Record<string, { readonly version: string; readonly integrity: string }>>;
};
const installed = JSON.parse(readFileSync(new URL("../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8")) as { readonly version: string };
const locked = lock.packages["node_modules/@earendil-works/pi-ai"]!;
if (installed.version !== locked.version) throw new Error("Installed Pi differs from the certification lockfile");
export const PI_RUNTIME_IDENTITY = Object.freeze({
  package: "@earendil-works/pi-ai",
  version: installed.version,
  integrity: locked.integrity,
});
