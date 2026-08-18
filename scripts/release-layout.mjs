// Electron release layout contract. The packaged desktop resolves the bundled
// Node backend under resources/backend; launcher.json remains the stable
// backend launch contract shared by assembly and certification.

export function launcherConfig() {
  return {
    backendNodeExecutable: "backend/node/node.exe",
    backendCliScript: "backend/dist/cli.js",
  };
}


/** Parses launcher.json exactly; undefined for any malformed or foreign
 *  shape. Never invents defaults. */
export function parseLauncherJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  if (Object.keys(parsed).sort().join(",") !== "backendCliScript,backendNodeExecutable") {
    return undefined;
  }
  const { backendNodeExecutable, backendCliScript } = parsed;
  if (
    typeof backendNodeExecutable !== "string" ||
    typeof backendCliScript !== "string" ||
    backendNodeExecutable.trim().length === 0 ||
    backendCliScript.trim().length === 0
  ) {
    return undefined;
  }
  return { backendNodeExecutable, backendCliScript };
}

/** Validates the installed release layout facts (paths relative to the exe
 *  directory). Returns a list of fixed failure labels; [] means valid. */
export function validateReleaseLayout(facts) {
  const launcher = parseLauncherJson(facts.launcherJson);
  if (launcher === undefined) {
    return ["launcher.json is invalid"];
  }
  const failures = [];
  if (!facts.nodeExecutableExists) {
    failures.push(`${launcher.backendNodeExecutable} is missing`);
  }
  if (!facts.cliScriptExists) {
    failures.push(`${launcher.backendCliScript} is missing`);
  }
  return failures;
}
