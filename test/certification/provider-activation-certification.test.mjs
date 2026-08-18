import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(target) {
  if (!(await exists(target))) return [];
  const stat = await import("node:fs/promises").then(({ stat }) => stat(target));
  if (stat.isFile()) return [target];
  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")),
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function display(file) {
  return path.relative(repositoryRoot, file).split(path.sep).join("/");
}

/**
 * Provider Activation Spec §23.8 — release certification (Ticket 15).
 *
 * These are static architecture gates that fail the release when a change
 * reintroduces the ownership defects the specification deletes: a second
 * Pi Models/credential composition in production serving, Data-Plane-owned
 * Catalog binding, optional normal-state Auth slots, static curated alias
 * defaults, or CommandCode-as-user-configuration behavior.
 */

test("production serving consumes the Backend-owned Provider Runtime instead of creating a second Pi Models composition", async () => {
  const composition = await readFile(
    path.join(repositoryRoot, "src", "composition.ts"),
    "utf8",
  );
  const application = await readFile(
    path.join(repositoryRoot, "src", "application.ts"),
    "utf8",
  );
  const supervisor = await readFile(
    path.join(repositoryRoot, "src", "runtime-supervisor.ts"),
    "utf8",
  );

  // The Data Plane composition must receive the injected Models through
  // the Provider Runtime seam — the serving composition never calls the
  // Provider creation entry points itself.
  assert.match(
    composition,
    /providerRuntime\.models/u,
    "Data Plane composition must consume providerRuntime.models",
  );
  assert.match(
    composition,
    /providerRuntime\.credentialAuthority/u,
    "Data Plane composition must consume providerRuntime.credentialAuthority",
  );
  assert.match(
    application,
    /createProviderRuntime\(/u,
    "Backend Application must own the Provider Runtime factory call",
  );
  assert.match(
    application,
    /catalogController\.bind\(providerRuntime\.catalog\)/u,
    "Catalog controller must bind to the Backend-lifetime Provider Runtime",
  );
  // The Data Plane listener must not bind the Catalog to its shutdown
  // signal (stopping the Gateway never tears down Provider management).
  assert.ok(
    !/startListener[\s\S]{0,600}catalogController\.bind/u.test(application),
    "Data Plane startup must not bind the Catalog controller",
  );
});

test("no optional normal-state Auth slots or Provider-config-derived readiness remain", async () => {
  const application = await readFile(
    path.join(repositoryRoot, "src", "application.ts"),
    "utf8",
  );
  const contracts = await readFile(
    path.join(
      repositoryRoot,
      "packages",
      "application-control-plane",
      "src",
      "contracts.ts",
    ),
    "utf8",
  );

  // The Auth handler is wired to the Backend-lifetime runtime, never to an
  // optional slot populated by Data Plane startup.
  assert.match(
    application,
    /createAuthLoginControlPlaneHandler\(\{[\s\S]*?models: \(\) => providerRuntime\?\.models/u,
    "Auth handler must close over the Backend-lifetime Provider Runtime",
  );
  assert.ok(
    !/\bauthModels\b/u.test(application),
    "the optional authModels normal-state slot must be gone",
  );
  // The coarse Provider readiness is a pure Catalog derivation.
  assert.match(
    application,
    /providerReadiness\(snapshot\)/u,
    "ApplicationStatus.provider must be derived from the Catalog snapshot",
  );
  assert.ok(
    !/configured.*providerPackages|providerPackages.*configured/u.test(application),
    "Provider readiness must not be derived from providerPackages presence",
  );
});

test("the static curated alias default table and defaults generation counter are removed", async () => {
  assert.equal(
    await exists(path.join(repositoryRoot, "src", "aliases", "defaults.ts")),
    false,
    "src/aliases/defaults.ts (curatedAliasDefaults) must be deleted",
  );
  for (const target of [
    path.join(repositoryRoot, "src", "aliases"),
    path.join(repositoryRoot, "packages", "application-control-plane", "src"),
  ]) {
    for (const file of await sourceFiles(target)) {
      const source = await readFile(file, "utf8");
      assert.ok(
        !/curatedAliasDefaults|CURATED_ALIAS_DEFAULTS_VERSION/u.test(source),
        `${display(file)} must not reference the static curated alias defaults`,
      );
      assert.ok(
        !/\bdefaultsVersion\b/u.test(source),
        `${display(file)} must not carry a redundant defaults generation counter`,
      );
    }
  }
});

test("CommandCode Private is a bundled product Provider, never a user providerPackages entry", async () => {
  const bundled = await readFile(
    path.join(repositoryRoot, "src", "providers", "bundled.ts"),
    "utf8",
  );
  const runtime = await readFile(
    path.join(repositoryRoot, "src", "providers", "runtime.ts"),
    "utf8",
  );
  assert.match(
    bundled,
    /@luckytoken\/provider-commandcode-private/u,
    "bundled metadata must carry the CommandCode package specifier",
  );
  assert.match(
    bundled,
    /commandcode-private/u,
    "bundled metadata must reserve the CommandCode Provider id",
  );
  assert.match(
    runtime,
    /assertUserProviderPackages/u,
    "user providerPackages claiming a bundled specifier must be rejected",
  );
  assert.match(
    runtime,
    /bundledProviderPackages/u,
    "Provider Runtime must load the bundled packages automatically",
  );
  assert.match(
    runtime,
    /luckytoken_bundled/u,
    "Provider Runtime must classify bundled Providers by product source",
  );
});

test("the packaged Electron activation journey is a release blocker", async () => {
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const desktopManifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "packages", "desktop-shell", "package.json"),
      "utf8",
    ),
  );
  assert.match(
    rootManifest.scripts["test:distribution"] ?? "",
    /test:product-e2e:run/u,
    "distribution certification must execute the packaged Electron product journeys",
  );
  assert.match(
    desktopManifest.scripts["test:product-e2e:run"] ?? "",
    /product-golden-journey\.e2e\.test\.mjs/u,
    "desktop must expose the release-blocking golden-journey runner",
  );
  assert.match(
    desktopManifest.scripts["test:product-e2e:run"] ?? "",
    /provider-activation-journey\.e2e\.test\.mjs/u,
    "desktop must expose the release-blocking Provider activation journey runner",
  );
});

test("the release assembly resolves the bundled CommandCode package as a runtime dependency", async () => {
  const assemble = await readFile(
    path.join(repositoryRoot, "scripts", "assemble-release-backend.mjs"),
    "utf8",
  );
  assert.match(
    assemble,
    /provider-commandcode-private/u,
    "release assembly must pack the bundled CommandCode package",
  );
  const desktopManifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "packages", "desktop-shell", "package.json"),
      "utf8",
    ),
  );
  assert.match(
    desktopManifest.scripts["build"] ?? "",
    /assemble:backend/u,
    "desktop build must assemble the backend with the bundled package",
  );
});

test("the renderer Providers page contains no Provider-ID branching", async () => {
  const providersPage = await readFile(
    path.join(
      repositoryRoot,
      "packages",
      "desktop-shell",
      "src",
      "renderer",
      "providers",
      "ProvidersPage.tsx",
    ),
    "utf8",
  );
  assert.ok(
    !/providerId\s*===\s*["']|provider\.providerId\s*===\s*["']/u.test(
      providersPage,
    ),
    "ProvidersPage must never branch on a concrete Provider id",
  );
  assert.ok(
    !/commandcode-private|anthropic/u.test(providersPage),
    "ProvidersPage must contain no concrete Provider identity text",
  );
});
