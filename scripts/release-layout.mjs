// Ticket 26 release layout contract. The Windows desktop executable reads
// launcher.json next to itself to find the bundled Node backend; this module
// is the single source of truth for that shape and the validation the
// certification suite enforces.

export function launcherConfig() {
  return {
    backendNodeExecutable: "backend/node/node.exe",
    backendCliScript: "backend/dist/cli.js",
  };
}

/**
 * Ticket 26 hardening: the NSIS installer must clear its saved install
 * location on uninstall, or a later install restores the previous (possibly
 * temporary or custom) directory. This is the single source of truth for
 * the hook wiring the certification suite enforces.
 */
export function releaseNsisHookConfig() {
  return {
    // Relative to src-tauri/, where tauri.release.conf.json lives.
    hooksFile: "installer-hooks.nsh",
    // The uninstall-time hook macro must unconditionally delete the
    // install-location memory key (Tauri's stock uninstaller only clears it
    // when the user opts to delete application data).
    requiredMacro: "NSIS_HOOK_PREUNINSTALL",
    requiredFragment: 'DeleteRegKey HKCU "${MANUPRODUCTKEY}"',
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
