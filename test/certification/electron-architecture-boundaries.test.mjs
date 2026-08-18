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

function importsOf(source, filename) {
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return imports;
}

async function importsUnder(targets) {
  const entries = [];
  for (const target of targets) {
    for (const file of await sourceFiles(target)) {
      const source = await readFile(file, "utf8");
      for (const specifier of importsOf(source, file)) {
        entries.push({ file, specifier });
      }
    }
  }
  return entries;
}

function display(file) {
  return path.relative(repositoryRoot, file).split(path.sep).join("/");
}

test("the model-serving Core seam has no Electron or Control Plane dependency", async () => {
  const currentCoreSeams = [
    path.join(repositoryRoot, "src", "runtime.ts"),
    path.join(repositoryRoot, "src", "http.ts"),
    path.join(repositoryRoot, "src", "execution.ts"),
    path.join(repositoryRoot, "src", "model-resolution.ts"),
    path.join(repositoryRoot, "src", "protocols"),
  ];
  const futureCore = path.join(repositoryRoot, "packages", "core", "src");

  for (const entry of await importsUnder([...currentCoreSeams, futureCore])) {
    assert.notEqual(
      entry.specifier,
      "electron",
      `${display(entry.file)} must not depend on Electron`,
    );
    assert.ok(
      !entry.specifier.startsWith("@luckytoken/application-control-plane"),
      `${display(entry.file)} must not depend on the Application Control Plane`,
    );
  }
});

test("the target renderer cannot import Node, Electron, Control Plane, or Core internals", async () => {
  const renderer = path.join(
    repositoryRoot,
    "packages",
    "desktop-shell",
    "src",
    "renderer",
  );
  for (const entry of await importsUnder([renderer])) {
    assert.ok(
      entry.specifier !== "electron" && !entry.specifier.startsWith("node:"),
      `${display(entry.file)} imports privileged runtime ${entry.specifier}`,
    );
    assert.ok(
      !entry.specifier.startsWith("@luckytoken/application-control-plane"),
      `${display(entry.file)} must depend on the Desktop API contract, not Control Plane directly`,
    );
    assert.ok(
      !entry.specifier.startsWith("@luckytoken/core") &&
        !entry.specifier.includes("/src/runtime") &&
        !entry.specifier.includes("/src/composition"),
      `${display(entry.file)} imports Core/application internals`,
    );
  }
});

test("Electron Main target modules do not deep-import Core implementation", async () => {
  const main = path.join(
    repositoryRoot,
    "packages",
    "desktop-shell",
    "src",
    "main",
  );
  for (const entry of await importsUnder([main])) {
    assert.ok(
      !entry.specifier.startsWith("@luckytoken/core/") &&
        !entry.specifier.includes("../../../src/") &&
        !entry.specifier.includes("../../../../src/"),
      `${display(entry.file)} deep-imports Backend/Core implementation`,
    );
  }
});

test("the Desktop API contract exposes no generic IPC escape hatch", async () => {
  const contractPath = path.join(
    repositoryRoot,
    "packages",
    "desktop-shell",
    "src",
    "shared",
    "desktop-api.ts",
  );
  const source = await readFile(contractPath, "utf8");
  assert.ok(!/\binvoke\s*\(/u.test(source), "Desktop API must not expose invoke(channel, payload)");
  assert.ok(!/\bsend\s*\(/u.test(source), "Desktop API must not expose send(channel, payload)");
  assert.ok(!/\bchannel\b/u.test(source), "Desktop API must not expose raw channel strings");
  assert.ok(!/\bcapability\b/u.test(source), "Desktop API must not expose Control Plane capability");
  assert.ok(!/\baddress\b/u.test(source), "Desktop API must not expose local IPC address");
});

test("the Electron desktop build path is independent of Tauri", async () => {
  const manifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "packages", "desktop-shell", "package.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.main, ".vite/build/main.js");
  for (const script of ["start", "dev", "build", "package", "make"]) {
    assert.equal(typeof manifest.scripts?.[script], "string", `missing ${script} script`);
    assert.ok(
      !manifest.scripts[script].includes("tauri"),
      `${script} must use the Electron path rather than Tauri`,
    );
  }
  assert.equal(
    await exists(
      path.join(repositoryRoot, "packages", "desktop-shell", "forge.config.cjs"),
    ),
    true,
  );
});

test("production desktop contains no Tauri, Rust, or legacy shell compatibility path", async () => {
  const forbiddenPaths = [
    "packages/desktop-shell/src-tauri",
    "packages/desktop-shell/src/control-plane-projection.ts",
    "packages/desktop-shell/src/tauri-shell-runtime.ts",
    "packages/desktop-shell/src/shell-lifecycle.ts",
    "packages/desktop-shell/src/App.tsx",
    "packages/desktop-shell/vite.config.ts",
  ];
  for (const relative of forbiddenPaths) {
    assert.equal(
      await exists(path.join(repositoryRoot, relative)),
      false,
      `${relative} must be removed after Electron cutover`,
    );
  }

  const manifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "packages", "desktop-shell", "package.json"),
      "utf8",
    ),
  );
  for (const dependencies of [manifest.dependencies ?? {}, manifest.devDependencies ?? {}]) {
    for (const name of Object.keys(dependencies)) {
      assert.ok(!name.startsWith("@tauri-apps/"), `desktop dependency ${name} reintroduces Tauri`);
    }
  }
  const lock = await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8");
  assert.ok(!lock.includes("@tauri-apps/"), "package-lock must not contain Tauri packages");
});

test("distribution certification is blocked by the Electron product golden journey", async () => {
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
    "distribution certification must execute the product golden journey",
  );
  assert.match(
    desktopManifest.scripts["test:product-e2e:run"] ?? "",
    /product-golden-journey\.e2e\.test\.mjs/u,
    "desktop must expose the release-blocking golden-journey runner",
  );
});

test("migration keeps explicit public-seam behavior suites", async () => {
  const requiredSuites = [
    "test/integration/client-protocol-boundary.test.ts",
    "test/integration/application-ownership.test.ts",
    "test/integration/control-plane.test.ts",
    "packages/desktop-shell/test/management-window-lifecycle.test.ts",
  ];
  for (const relative of requiredSuites) {
    assert.equal(
      await exists(path.join(repositoryRoot, relative)),
      true,
      `missing migration seam suite: ${relative}`,
    );
  }
});
