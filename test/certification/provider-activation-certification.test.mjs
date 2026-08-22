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
 * Pi Models/Profile composition in production serving, Data-Plane-owned
 * Catalog binding, optional normal-state Provider owners, static curated
 * alias defaults, or CommandCode-as-user-configuration behavior.
 */

test("production serving receives narrow Provider capabilities and cannot create Provider composition", async () => {
  const composition = await readFile(
    path.join(repositoryRoot, "src", "composition.ts"),
    "utf8",
  );
  const application = await readFile(
    path.join(repositoryRoot, "src", "application.ts"),
    "utf8",
  );
  assert.ok(
    !/\bProviderRuntime\b|\bproviderRuntime\b/u.test(composition),
    "Data Plane composition must not know the broad ProviderRuntime",
  );
  for (const forbiddenFactory of [
    "createModels",
    "registerLuckyTokenProviders",
    "loadProviderPackages",
    "createLiveCredentialAuthority",
    "createCatalogSnapshotModels",
  ]) {
    assert.ok(
      !new RegExp(`\\b${forbiddenFactory}\\b`, "u").test(composition),
      `Data Plane composition must not reference ${forbiddenFactory}`,
    );
  }
  assert.match(composition, /readonly models:\s*Models/u);
  assert.match(
    composition,
    /readonly scrubSensitiveText:\s*\(value:\s*string\)\s*=>\s*string/u,
  );
  assert.match(
    application,
    /createProviderRuntime\(/u,
    "Backend Application must own the Provider Runtime factory call",
  );
  assert.match(
    application,
    /createConfiguredLuckyTokenDataPlane\(\{[\s\S]*?models:\s*providerRuntime\.models/u,
    "Backend Application must project Models into the Data Plane",
  );
  assert.match(
    application,
    /createConfiguredLuckyTokenDataPlane\(\{[\s\S]*?scrubSensitiveText/u,
    "Backend Application must assemble the narrow scrub capability",
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

test("the Backend owns one Profile state owner and exposes only narrow consumer views", async () => {
  const application = await readFile(
    path.join(repositoryRoot, "src", "application.ts"),
    "utf8",
  );
  const runtime = await readFile(
    path.join(
      repositoryRoot,
      "src",
      "providers",
      "runtime.ts",
    ),
    "utf8",
  );
  const profileContracts = await readFile(
    path.join(repositoryRoot, "src", "credentials", "profile-contract.ts"),
    "utf8",
  );

  // Management and request binding are projections of the one
  // Backend-lifetime Profile state owner. Pi's secret-bearing
  // CredentialStore is created only inside Provider Runtime composition.
  assert.match(
    application,
    /createCredentialProfilesControlPlaneHandlers\(\{[\s\S]*?management: credentialManagement,[\s\S]*?binding: providerRuntime\.providerAuthBindings/u,
    "Profile Control Plane must receive only the management and binding views",
  );
  assert.match(
    runtime,
    /createProviderCredentialProfiles\(/u,
    "Provider Runtime must create the one Backend-lifetime Profile state owner",
  );
  assert.match(
    runtime,
    /createModels\([\s\S]*?credentials:\s*profileState\.credentialStore/u,
    "Pi's CredentialStore adapter must be injected only at composition",
  );
  assert.ok(
    !/CredentialStore/u.test(profileContracts),
    "public Profile contracts must not expose Pi's secret-bearing CredentialStore",
  );
  assert.ok(
    !/let\s+(?:credentialManagement|providerAuthBindings|providerRuntime)\s*:/u.test(application),
    "Backend-lifetime Provider owners must not be optional normal-state slots",
  );
  assert.ok(
    !/\bcredentialStore\s*\(\s*\)/u.test(profileContracts),
    "public Profile interfaces must not provide a credentialStore escape hatch",
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

test("legacy single-slot credential contracts cannot return to production", async () => {
  const deletedPaths = [
    ["src", "credentials", "authority.ts"],
    ["src", "credentials", "control-plane.ts"],
    ["src", "credentials", "login-control-plane.ts"],
    ["src", "pi", "file-credential-store.ts"],
  ];
  for (const parts of deletedPaths) {
    assert.equal(
      await exists(path.join(repositoryRoot, ...parts)),
      false,
      `${parts.join("/")} must remain deleted`,
    );
  }

  for (const target of [
    path.join(repositoryRoot, "src"),
    path.join(repositoryRoot, "packages", "application-control-plane", "src"),
    path.join(repositoryRoot, "packages", "desktop-shell", "src"),
  ]) {
    for (const file of await sourceFiles(target)) {
      const source = await readFile(file, "utf8");
      for (const forbidden of [
        "createLiveCredentialAuthority",
        "createAuthLoginControlPlaneHandler",
        "executeCredentialCommand",
        "executeAuthCommand",
      ]) {
        assert.ok(
          !new RegExp(`\\b${forbidden}\\b`, "u").test(source),
          `${display(file)} must not reference deleted ${forbidden}`,
        );
      }
    }
  }

  const runtime = await readFile(
    path.join(repositoryRoot, "src", "providers", "runtime.ts"),
    "utf8",
  );
  assert.ok(
    !/["']auth\.json["']/u.test(runtime),
    "Provider Runtime must not read legacy Pi auth.json",
  );
  assert.match(
    runtime,
    /createFileProviderCredentialRecordStore/u,
    "Provider Runtime must compose the per-Provider record store",
  );
  const recordStore = await readFile(
    path.join(repositoryRoot, "src", "credentials", "profile-record-store.ts"),
    "utf8",
  );
  assert.match(
    recordStore,
    /credential-profiles/u,
    "Profile store must persist independent per-Provider records",
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

test("both CommandCode integrations are bundled product Providers", async () => {
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
    bundled,
    /@luckytoken\/provider-commandcode-goat/u,
    "bundled metadata must carry the CommandCode Goat package specifier",
  );
  assert.match(
    bundled,
    /commandcode-goat/u,
    "bundled metadata must reserve the CommandCode Goat Provider id",
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
  const distributionCommands = [
    rootManifest.scripts["test:distribution"],
    rootManifest.scripts["test:distribution:inner"],
  ].join(" ");
  const productJourneyCommands = [
    desktopManifest.scripts["test:product-e2e:run"],
    desktopManifest.scripts["test:product-e2e:run:inner"],
  ].join(" ");
  assert.match(
    distributionCommands,
    /test:product-e2e:run/u,
    "distribution certification must execute the packaged Electron product journeys",
  );
  assert.match(
    productJourneyCommands,
    /product-golden-journey\.e2e\.test\.mjs/u,
    "desktop must expose the release-blocking golden-journey runner",
  );
  assert.match(
    productJourneyCommands,
    /provider-activation-journey\.e2e\.test\.mjs/u,
    "desktop must expose the release-blocking Provider activation journey runner",
  );
});

test("the release assembly resolves every bundled CommandCode package", async () => {
  const assemble = await readFile(
    path.join(repositoryRoot, "scripts", "assemble-release-backend.mjs"),
    "utf8",
  );
  assert.match(
    assemble,
    /provider-commandcode-private/u,
    "release assembly must pack the bundled CommandCode package",
  );
  assert.match(
    assemble,
    /commandcode-model-catalog/u,
    "release assembly must pack the shared CommandCode model catalog",
  );
  assert.match(
    assemble,
    /provider-commandcode-goat/u,
    "release assembly must pack the bundled CommandCode Goat package",
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
    !/commandcode-private|commandcode-goat|anthropic/u.test(providersPage),
    "ProvidersPage must contain no concrete Provider identity text",
  );
});
