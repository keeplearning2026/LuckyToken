import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";

const childScript = fileURLToPath(
  new URL("../fixtures/sqlite-instance-lock-child.mjs", import.meta.url),
);

function spawnChild(mode, databasePath, argument) {
  const child = spawn(
    process.execPath,
    [childScript, mode, databasePath, ...(argument === undefined ? [] : [String(argument)])],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = [];
  const waiters = [];
  const stderr = [];
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter === undefined) lines.push(line);
    else waiter.resolve(line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.once("exit", (code, signal) => {
    while (waiters.length > 0) {
      waiters.shift().reject(
        new Error(
          `sqlite lock child exited before output (code=${String(code)}, signal=${String(signal)}): ${stderr.join("")}`,
        ),
      );
    }
  });
  return {
    child,
    async line(timeoutMs = 3_000) {
      if (lines.length > 0) return lines.shift();
      let timer;
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        waiters.push(waiter);
        timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(`Timed out waiting for sqlite lock child output: ${stderr.join("")}`),
          );
        }, timeoutMs);
      });
    },
    send(line) {
      child.stdin.write(`${line}\n`);
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "luckytoken-instance-sqlite-"));
  return join(directory, "instance.sqlite");
}

async function expectBusy(databasePath) {
  const contender = spawnChild("try-once", databasePath);
  const line = await contender.line();
  assert.match(line, /^BUSY:ERR_SQLITE_ERROR$/u);
  await new Promise((resolve) => contender.child.once("exit", resolve));
}

test("BEGIN IMMEDIATE excludes another process without a stale timeout", async () => {
  const databasePath = await fixture();
  const holder = spawnChild("hold", databasePath);
  try {
    assert.equal(await holder.line(), "ACQUIRED");
    await expectBusy(databasePath);
  } finally {
    await holder.kill();
  }
});

test("event-loop suspension does not surrender SQLite instance authority", async () => {
  const databasePath = await fixture();
  const holder = spawnChild("hold-block", databasePath, 1_500);
  try {
    assert.equal(await holder.line(), "ACQUIRED");
    await expectBusy(databasePath);
    assert.equal(await holder.line(3_000), "UNBLOCKED");
    await expectBusy(databasePath);
  } finally {
    await holder.kill();
  }
});

test("process death releases authority without deleting or repairing the carrier file", async () => {
  const databasePath = await fixture();
  const first = spawnChild("hold", databasePath);
  assert.equal(await first.line(), "ACQUIRED");
  await first.kill();

  await stat(databasePath);
  const second = spawnChild("hold", databasePath);
  try {
    assert.equal(await second.line(), "ACQUIRED");
    await stat(databasePath);
  } finally {
    await second.kill();
  }
});

test("normal rollback and close releases authority immediately", async () => {
  const databasePath = await fixture();
  const first = new DatabaseSync(databasePath, { timeout: 0 });
  first.exec("BEGIN IMMEDIATE");
  first.exec("ROLLBACK");
  first.close();

  const second = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    assert.doesNotThrow(() => second.exec("BEGIN IMMEDIATE"));
    second.exec("ROLLBACK");
  } finally {
    second.close();
  }
  await stat(databasePath);
});

test("twenty synchronized processes elect exactly one SQLite lock winner", async () => {
  const databasePath = await fixture();
  const contenders = Array.from({ length: 20 }, () =>
    spawnChild("barrier-contender", databasePath),
  );
  try {
    assert.deepEqual(
      await Promise.all(contenders.map((contender) => contender.line())),
      Array.from({ length: 20 }, () => "READY"),
    );
    for (const contender of contenders) contender.send("GO");
    const results = await Promise.all(contenders.map((contender) => contender.line()));
    const winners = contenders.filter((_contender, index) => results[index] === "ACQUIRED");
    const losers = results.filter((result) => result.startsWith("BUSY:"));
    assert.equal(winners.length, 1, `unexpected contender results: ${results.join(", ")}`);
    assert.equal(losers.length, 19, `unexpected contender results: ${results.join(", ")}`);
    winners[0].send("RELEASE");
    assert.equal(await winners[0].line(), "RELEASED");
  } finally {
    await Promise.all(contenders.map((contender) => contender.kill()));
  }
});

test("two SQLite connections in one process cannot both own the instance", async () => {
  const databasePath = await fixture();
  const first = new DatabaseSync(databasePath, { timeout: 0 });
  const second = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    first.exec("BEGIN IMMEDIATE");
    assert.throws(
      () => second.exec("BEGIN IMMEDIATE"),
      (error) => error?.code === "ERR_SQLITE_ERROR" && /database is locked/iu.test(error.message),
    );
  } finally {
    try {
      first.exec("ROLLBACK");
    } finally {
      first.close();
      second.close();
    }
  }
});
