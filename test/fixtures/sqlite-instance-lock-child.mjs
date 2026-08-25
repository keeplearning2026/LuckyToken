import { DatabaseSync } from "node:sqlite";

const [mode, databasePath, argument] = process.argv.slice(2);

function openDatabase() {
  return new DatabaseSync(databasePath, { timeout: 0 });
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function acquire(database) {
  database.exec("BEGIN IMMEDIATE");
}

function release(database) {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}

async function waitForLine() {
  process.stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      process.stdin.off("data", onData);
      resolve(buffered.slice(0, newline).trim());
    };
    process.stdin.on("data", onData);
  });
}

if (mode === "hold") {
  const database = openDatabase();
  globalThis.__TokenHeldInstanceDatabase = database;
  acquire(database);
  writeLine("ACQUIRED");
  setInterval(() => globalThis.__TokenHeldInstanceDatabase, 60_000);
} else if (mode === "hold-block") {
  const database = openDatabase();
  globalThis.__TokenHeldInstanceDatabase = database;
  acquire(database);
  writeLine("ACQUIRED");
  const durationMs = Number(argument ?? "1500");
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    // Deliberately block the event loop while the OS/SQLite lock stays held.
  }
  writeLine("UNBLOCKED");
  setInterval(() => globalThis.__TokenHeldInstanceDatabase, 60_000);
} else if (mode === "try-once") {
  const database = openDatabase();
  try {
    acquire(database);
    writeLine("ACQUIRED");
    release(database);
  } catch (error) {
    database.close();
    writeLine(`BUSY:${errorCode(error) ?? "unknown"}`);
  }
} else if (mode === "barrier-contender") {
  const database = openDatabase();
  writeLine("READY");
  const command = await waitForLine();
  if (command !== "GO") throw new Error(`Unexpected barrier command: ${command}`);
  try {
    acquire(database);
    writeLine("ACQUIRED");
    const releaseCommand = await waitForLine();
    if (releaseCommand !== "RELEASE") {
      throw new Error(`Unexpected release command: ${releaseCommand}`);
    }
    release(database);
    writeLine("RELEASED");
  } catch (error) {
    database.close();
    writeLine(`BUSY:${errorCode(error) ?? "unknown"}`);
  }
} else {
  throw new Error(`Unknown sqlite instance-lock child mode: ${String(mode)}`);
}
