import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createResponseSessionState,
  type ResponseSessionStateOptions,
} from "../../src/protocols/openai-responses/session-state.js";

describe("12: Responses local response state", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function fixtureState(options: Partial<ResponseSessionStateOptions> = {}) {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-state-"));
    directories.push(directory);
    const stateFile = join(directory, "openai-responses.json");
    return {
      stateFile,
      directory,
      create: () =>
        createResponseSessionState({
          stateFile,
          ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
          ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
          ...(options.storeFalsePolicy === undefined
            ? {}
            : { storeFalsePolicy: options.storeFalsePolicy }),
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
    };
  }

  const completedResponse = (id: string, output: unknown[] = []) => ({
    id,
    status: "completed",
    output,
  });

  function attemptExpand(state: ReturnType<typeof createResponseSessionState>, body: unknown): Promise<unknown> {
    return state.expand(body);
  }

  it("prepends stored items in exact order for a known previous_response_id", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: [{ role: "user", content: "hello" }] },
      completedResponse("resp_1", [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      ]),
    );
    await state.flush();

    const expanded = await attemptExpand(state, {
      model: "m",
      input: [{ role: "user", content: "next" }],
      previous_response_id: "resp_1",
    });
    expect(expanded).toMatchObject({
      input: [
        { role: "user", content: "hello" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
        { role: "user", content: "next" },
      ],
    });
  });

  it("round-trips saved history through the snapshot file into a fresh instance", async () => {
    const { stateFile, create } = await fixtureState();
    const first = create();
    await first.remember(
      { input: [{ role: "user", content: "hello" }] },
      completedResponse("resp_1", [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }]),
    );
    await first.flush();

    const second = create();
    const expanded = await second.expand({
      model: "m",
      input: [{ role: "user", content: "next" }],
      previous_response_id: "resp_1",
    });
    expect(expanded).toMatchObject({
      input: [
        { role: "user", content: "hello" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
        { role: "user", content: "next" },
      ],
    });
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
      version: 3,
    });
  });

  it("errors on an unknown previous_response_id (no fail-open)", async () => {
    const { create } = await fixtureState();
    const state = create();
    await expect(
      attemptExpand(state, {
        model: "m",
        input: "increment",
        previous_response_id: "resp_unknown",
      }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
  });

  it("errors on an expired previous_response_id", async () => {
    let current = 1_000_000;
    const { create } = await fixtureState({ now: () => current, ttlMs: 100 });
    const state = create();
    await state.remember(
      { input: "old" },
      completedResponse("resp_old", []),
    );
    await state.flush();
    current += 101;

    await expect(
      attemptExpand(state, {
        model: "m",
        input: "new",
        previous_response_id: "resp_old",
      }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
  });

  it("errors on an evicted previous_response_id", async () => {
    const { create } = await fixtureState({ maxEntries: 2 });
    const state = create();
    await state.remember({ input: "one" }, completedResponse("resp_1", []));
    await state.remember({ input: "two" }, completedResponse("resp_2", []));
    await state.remember({ input: "three" }, completedResponse("resp_3", []));

    await expect(
      attemptExpand(state, {
        model: "m",
        input: "x",
        previous_response_id: "resp_1",
      }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    expect(await state.expand({ input: "x", previous_response_id: "resp_2" })).toMatchObject({
      input: [
        { role: "user", content: "two" },
        { role: "user", content: "x" },
      ],
    });
  });

  it("errors on an unresolvable previous_response_id (a referenced missing entry)", async () => {
    const { create } = await fixtureState();
    const state = create();
    // A response was saved, but its entry is not resolvable: simulate a
    // snapshot that references an ID whose entry is missing (corrupt chain).
    await state.remember(
      { input: "history", previous_response_id: "resp_ghost" },
      completedResponse("resp_chain", []),
    );
    await expect(
      attemptExpand(state, {
        model: "m",
        input: "y",
        previous_response_id: "resp_chain",
      }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
  });

  it("quarantines a corrupt snapshot and errors for a specifically referenced ID", async () => {
    const { stateFile, create } = await fixtureState();
    await writeFile(stateFile, "{ not json", "utf8");

    const state = create();
    await expect(
      attemptExpand(state, {
        model: "m",
        input: "x",
        previous_response_id: "resp_any",
      }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    const { access } = await import("node:fs/promises");
    await expect(access(`${stateFile}.corrupt`)).resolves.toBeUndefined();
  });

  it("honors store:false by storing neither memory nor disk", async () => {
    const { stateFile, create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: "secret", store: false },
      completedResponse("resp_honor", []),
    );
    await state.flush();

    expect(state.size()).toBe(0);
    // honor stores neither memory nor disk: no snapshot file is written at all.
    const { access } = await import("node:fs/promises");
    await expect(access(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      attemptExpand(state, {
        model: "m",
        input: "x",
        previous_response_id: "resp_honor",
      }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
  });

  it("keeps store:false in memory only under the memory policy", async () => {
    const { create } = await fixtureState({ storeFalsePolicy: "memory" });
    const state = create();
    await state.remember(
      { input: "process only", store: false },
      completedResponse("resp_mem", []),
    );
    await state.flush();

    expect(state.size()).toBe(1);
    expect(await state.expand({ input: "x", previous_response_id: "resp_mem" })).toMatchObject({
      input: [
        { role: "user", content: "process only" },
        { role: "user", content: "x" },
      ],
    });
  });

  it("persists store:false under the persist policy and reports a notice", async () => {
    const { create } = await fixtureState({ storeFalsePolicy: "persist" });
    const state = create();
    const notices: string[] = [];
    await state.remember(
      { input: "kept", store: false },
      completedResponse("resp_persist", []),
      (code) => notices.push(code),
    );
    await state.flush();

    expect(state.size()).toBe(1);
    expect(notices).toEqual(["openai-responses_store_false_persisted"]);
    expect(await state.expand({ input: "x", previous_response_id: "resp_persist" })).toMatchObject({
      input: [
        { role: "user", content: "kept" },
        { role: "user", content: "x" },
      ],
    });
  });

  it("does not wait for the commit before a continuation may resolve (documented race)", async () => {
    // Deterministic demonstration: the remember() promise is not awaited
    // before expand() runs; the store must not synchronously complete a write
    // that would make the immediately-following expand() always succeed.
    const { create } = await fixtureState();
    const state = create();
    const pending = state.remember(
      { input: "racing" },
      completedResponse("resp_race", []),
    );
    // Do NOT await pending: this is the documented immediate-continuation
    // race. expand may observe the entry (memory state is synchronous) or a
    // failed commit, but the response must not have blocked on the commit.
    const expanded = await state.expand({
      model: "m",
      input: "continue",
      previous_response_id: "resp_race",
    });
    await pending;
    expect(expanded).toMatchObject({
      input: [
        { role: "user", content: "racing" },
        { role: "user", content: "continue" },
      ],
    });
  });

  it("evicts oldest entries past the entry cap", async () => {
    const { create } = await fixtureState({ maxEntries: 2 });
    const state = create();
    await state.remember({ input: "one" }, completedResponse("resp_1", []));
    await state.remember({ input: "two" }, completedResponse("resp_2", []));
    await state.remember({ input: "three" }, completedResponse("resp_3", []));

    expect(await state.expand({ input: "x", previous_response_id: "resp_2" })).toMatchObject({
      input: [
        { role: "user", content: "two" },
        { role: "user", content: "x" },
      ],
    });
    expect(await state.expand({ input: "x", previous_response_id: "resp_3" })).toMatchObject({
      input: [
        { role: "user", content: "three" },
        { role: "user", content: "x" },
      ],
    });
    expect(state.size()).toBe(2);
  });

  it("never writes a snapshot the next load refuses (closed limits)", async () => {
    const { stateFile, create } = await fixtureState();
    const state = create();
    // A snapshot written with a moderately large but admitted history must
    // load cleanly in a fresh instance (write-side and load-side caps are
    // mutually compatible).
    const text = "x".repeat(100_000);
    await state.remember(
      { input: text },
      completedResponse("resp_big", []),
    );
    await state.flush();
    const onDisk = JSON.parse(await readFile(stateFile, "utf8"));
    expect(String(onDisk.states[0]?.[1]?.items?.[0]?.content).length).toBe(100_000);

    // Loading the snapshot in a fresh instance must succeed (no refusal).
    const second = create();
    await expect(
      second.expand({ input: "y", previous_response_id: "resp_big" }),
    ).resolves.toMatchObject({
      input: [
        { role: "user", content: expect.stringContaining("x".repeat(10)) },
        { role: "user", content: "y" },
      ],
    });
  });

  it("writes atomically with same-directory temp + rename and serializes writes", async () => {
    const { stateFile, create } = await fixtureState();
    const state = create();
    // Fire many remembers without awaiting; writes must serialize and never
    // interleave partial snapshots.
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        state.remember(
          { input: `item-${index}` },
          completedResponse(`resp_${index}`, []),
        ),
      ),
    );
    await state.flush();

    const loaded = JSON.parse(await readFile(stateFile, "utf8"));
    const ids = loaded.states.map((entry: [string, unknown]) => entry[0]);
    expect(ids).toEqual(Array.from({ length: 12 }, (_, index) => `resp_${index}`));
  });

  it("drops orphan function_call_output items when saving (storage hygiene)", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      {
        input: [
          {
            type: "function_call_output",
            call_id: "call_orphan",
            output: "result",
          },
          { type: "message", role: "user", content: "continue" },
        ],
      },
      completedResponse("resp_clean", []),
    );
    await state.flush();

    const expanded = await state.expand({
      input: "next",
      previous_response_id: "resp_clean",
    });
    const items = (expanded as { input: unknown[] }).input;
    const types = items.map((item) =>
      typeof item === "object" && item !== null && "type" in item
        ? (item as { type: string }).type
        : "message",
    );
    expect(types).toEqual(["message", "message"]);
  });

  it("self-heals orphan items already on disk at load time", async () => {
    const { stateFile, create } = await fixtureState();
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 3,
        states: [
          [
            "resp_legacy",
            {
              createdAt: Date.now(),
              items: [
                {
                  type: "function_call_output",
                  call_id: "call_legacy_orphan",
                  output: "stale result",
                },
                { role: "user", content: "history" },
              ],
            },
          ],
        ],
      }),
      "utf8",
    );

    const state = create();
    const expanded = await state.expand({
      input: "next",
      previous_response_id: "resp_legacy",
    });
    const items = (expanded as { input: unknown[] }).input;
    const types = items.map((item) =>
      typeof item === "object" && item !== null && "type" in item
        ? (item as { type: string }).type
        : "message",
    );
    expect(types).toEqual(["message", "message"]);
  });

  it("never saves a request whose own previous_response_id failed to expand", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: "delta", previous_response_id: "resp_missing" },
      completedResponse("resp_bad_chain", []),
    );
    await state.flush();

    await expect(
      attemptExpand(state, {
        input: "y",
        previous_response_id: "resp_bad_chain",
      }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
  });

  it("saves only completed or max_output_tokens-incomplete responses", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: "incomplete-ok" },
      {
        id: "resp_incomplete_ok",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", role: "assistant", content: [] }],
      },
    );
    await state.remember(
      { input: "incomplete-filter" },
      {
        id: "resp_incomplete_filter",
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output: [],
      },
    );
    await state.remember(
      { input: "failed" },
      { id: "resp_failed", status: "failed", output: [] },
    );
    await state.flush();

    expect(state.size()).toBe(1);
    await expect(
      attemptExpand(state, { input: "x", previous_response_id: "resp_incomplete_ok" }),
    ).resolves.toMatchObject({
      input: [
        { role: "user", content: "incomplete-ok" },
        { type: "message", role: "assistant", content: [] },
        { role: "user", content: "x" },
      ],
    });
  });

  it("exposes no mutable entry objects through the public interface", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: [{ role: "user", content: "stable" }] },
      completedResponse("resp_1", [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      ]),
    );
    await state.flush();

    // Concurrent expansions must return independent, non-aliased arrays.
    const [a, b] = await Promise.all([
      state.expand({ input: "next", previous_response_id: "resp_1" }),
      state.expand({ input: "next", previous_response_id: "resp_1" }),
    ]);
    const inputA = (a as { input: unknown[] }).input;
    const inputB = (b as { input: unknown[] }).input;
    expect(inputA).not.toBe(inputB);
    expect(inputA).toEqual(inputB);
    // Mutating a returned expansion must not affect the store.
    (inputA[0] as Record<string, unknown>).role = "system";
    const again = await state.expand({ input: "next", previous_response_id: "resp_1" });
    expect((again as { input: unknown[] }).input[0]).toMatchObject({ role: "user" });
  });

  it("flushes a pending debounced write immediately", async () => {
    const { stateFile, create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: "flush me" },
      completedResponse("resp_flush", []),
    );
    await state.flush();

    const loaded = JSON.parse(await readFile(stateFile, "utf8"));
    expect(loaded.states).toEqual([
      ["resp_flush", { createdAt: expect.any(Number), items: [{ role: "user", content: "flush me" }] }],
    ]);
  });
});

describe("12 recheck: snapshot byte units stay mutually compatible", () => {
  it("round-trips a non-ASCII history through the snapshot file", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-utf8-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({ stateFile });
      const chinese = "中文内容".repeat(500);
      await state.remember(
        { input: chinese },
        { id: "resp_utf8", status: "completed", output: [] },
      );
      await state.flush();
      // The on-disk file must load in a fresh instance (write-side and
      // load-side caps use the same UTF-8 byte unit).
      const second = createResponseSessionState({ stateFile });
      const expanded = await second.expand({
        input: "next",
        previous_response_id: "resp_utf8",
      });
      expect(
        (expanded as { input: unknown[] }).input[0],
      ).toMatchObject({ role: "user", content: chinese });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: load-side entry caps stay closed", () => {
  it("clips oversized entries at load time to the same bound the writer uses", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-closed-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      // Hand-written snapshot with an entry carrying more items than the
      // writer would ever emit (MAX_ENTRY_ITEMS = 1000).
      const hugeItems = Array.from({ length: 2000 }, (_, i) => ({
        role: "user",
        content: `item-${i}`,
      }));
      await writeFile(
        stateFile,
        JSON.stringify({
          version: 3,
          states: [
            [
              "resp_huge",
              { createdAt: Date.now(), items: hugeItems },
            ],
          ],
        }),
        "utf8",
      );
      const state = createResponseSessionState({ stateFile });
      const expanded = (await state.expand({
        input: "next",
        previous_response_id: "resp_huge",
      })) as { input: unknown[] };
      // The loaded entry is clipped to the writer's item bound, so the
      // expansion cannot exceed the closed contract.
      expect(expanded.input).toHaveLength(1000 + 1);
      await state.flush();
      expect(JSON.parse(await readFile(stateFile, "utf8")).states[0][1].items).toHaveLength(1000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: memory store:false never touches disk", () => {
  it("keeps store:false=memory entries process-only (no disk write)", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-mem-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({
        stateFile,
        storeFalsePolicy: "memory",
      });
      await state.remember(
        { input: "process only", store: false },
        { id: "resp_mem", status: "completed", output: [] },
      );
      // Even a normal (store:true) entry schedules a persist; the memory-only
      // entry must not drag a snapshot to disk.
      await state.remember(
        { input: "normal", store: true },
        { id: "resp_normal", status: "completed", output: [] },
      );
      await state.flush();
      const onDisk = JSON.parse(await readFile(stateFile, "utf8"));
      const ids = onDisk.states.map((entry: [string, unknown]) => entry[0]);
      expect(ids).toEqual(["resp_normal"]);
      expect(ids).not.toContain("resp_mem");
      // And a fresh instance must not see the memory-only entry.
      const second = createResponseSessionState({ stateFile });
      await expect(
        second.expand({ input: "x", previous_response_id: "resp_mem" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: TTL-expired entries poison nothing", () => {
  it("never saves an increment whose previous_response_id has already expired", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-ttl-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      let current = 1_000_000;
      const state = createResponseSessionState({
        stateFile,
        now: () => current,
        ttlMs: 100,
      });
      const complete = (id: string, output: unknown[] = []) => ({
        id,
        status: "completed",
        output,
      });
      await state.remember(
        { input: "old" },
        complete("resp_old"),
      );
      current += 101; // old entry is now TTL-expired in memory.

      // A follow-up increment referencing the expired ID must be rejected by
      // the anti-poisoning admission, not saved.
      await state.remember(
        { input: "increment", previous_response_id: "resp_old" },
        complete("resp_chain"),
      );
      await state.flush();
      expect(state.size()).toBe(1); // only resp_old remains (no resp_chain)
      await expect(
        state.expand({ input: "y", previous_response_id: "resp_chain" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: concurrent interleaving stays consistent", () => {
  it("handles interleaved remember/expand/flush without corruption or crashes", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-conc-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({ stateFile });
      const complete = (id: string) => ({ id, status: "completed", output: [] });
      // Fire a mix of remembers, expansions, and flushes without awaiting
      // between them; the store must never corrupt or throw spuriously.
      await Promise.all([
        state.remember({ input: "a" }, complete("resp_a")),
        state.expand({ input: "x", previous_response_id: "resp_a" }).catch(() => undefined),
        state.remember({ input: "b" }, complete("resp_b")),
        state.flush(),
        state.expand({ input: "y", previous_response_id: "resp_b" }).catch(() => undefined),
        state.remember({ input: "c" }, complete("resp_c")),
        state.flush(),
        state.expand({ input: "z", previous_response_id: "resp_c" }).catch(() => undefined),
      ]);
      // All three entries survive and are expandable.
      for (const id of ["resp_a", "resp_b", "resp_c"]) {
        const expanded = await state.expand({ input: "tail", previous_response_id: id });
        expect((expanded as { input: unknown[] }).input).toHaveLength(2);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: memory-only store leaves no file behind", () => {
  it("flush after only memory-only entries creates no snapshot file", async () => {
    const { mkdtemp, access, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-nofile-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({
        stateFile,
        storeFalsePolicy: "memory",
      });
      await state.remember(
        { input: "only memory", store: false },
        { id: "resp_mem", status: "completed", output: [] },
      );
      await state.flush();
      // memory stores process-only: no snapshot file may exist at all.
      await expect(access(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: TTL boundary values", () => {
  it("accepts an entry exactly at the TTL boundary", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-ttlb-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      let current = 1_000_000;
      const state = createResponseSessionState({
        stateFile,
        now: () => current,
        ttlMs: 100,
      });
      await state.remember(
        { input: "at-boundary" },
        { id: "resp_boundary", status: "completed", output: [] },
      );
      current += 100; // exactly at TTL: still valid
      const expanded = await state.expand({
        input: "next",
        previous_response_id: "resp_boundary",
      });
      expect((expanded as { input: unknown[] }).input).toHaveLength(2);
      current += 1; // past TTL: expired
      await expect(
        state.expand({ input: "x", previous_response_id: "resp_boundary" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an entry exactly at maxEntries with eviction of the oldest", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-cap-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({ stateFile, maxEntries: 2 });
      await state.remember(
        { input: "one" },
        { id: "resp_1", status: "completed", output: [] },
      );
      await state.remember(
        { input: "two" },
        { id: "resp_2", status: "completed", output: [] },
      );
      // Exactly at capacity: adding a third evicts the oldest (resp_1).
      await state.remember(
        { input: "three" },
        { id: "resp_3", status: "completed", output: [] },
      );
      expect(state.size()).toBe(2);
      await expect(
        state.expand({ input: "x", previous_response_id: "resp_1" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
      await expect(
        state.expand({ input: "x", previous_response_id: "resp_3" }),
      ).resolves.toMatchObject({ input: expect.any(Array) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: quarantine then reload", () => {
  it("recovers cleanly after a corrupt snapshot is quarantined and new data is written", async () => {
    const { mkdtemp, writeFile, readFile, access, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-quar-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      await writeFile(stateFile, "{ corrupt", "utf8");
      // First load quarantines the corrupt file.
      const first = createResponseSessionState({ stateFile });
      await expect(
        first.expand({ input: "x", previous_response_id: "resp_any" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
      await expect(access(`${stateFile}.corrupt`)).resolves.toBeUndefined();

      // New successful data is written as a fresh snapshot.
      await first.remember(
        { input: "fresh" },
        { id: "resp_fresh", status: "completed", output: [] },
      );
      await first.flush();
      const onDisk = JSON.parse(await readFile(stateFile, "utf8"));
      expect(onDisk.states.map((e: [string, unknown]) => e[0])).toEqual(["resp_fresh"]);

      // A fresh instance loads the new snapshot and ignores the quarantine.
      const second = createResponseSessionState({ stateFile });
      const expanded = await second.expand({
        input: "tail",
        previous_response_id: "resp_fresh",
      });
      expect((expanded as { input: unknown[] }).input).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: prototype pollution in stored items", () => {
  it("does not pollute the expansion when stored items carry __proto__ keys", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-proto-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({ stateFile });
      const hostile = JSON.parse(
        '{"role":"user","content":"hi","__proto__":{"polluted":true}}',
      ) as Record<string, unknown>;
      await state.remember(
        { input: [hostile] },
        { id: "resp_proto", status: "completed", output: [] },
      );
      const expanded = (await state.expand({
        input: "next",
        previous_response_id: "resp_proto",
      })) as { input: unknown[] };
      const first = expanded.input[0] as Record<string, unknown>;
      expect(Object.getPrototypeOf(first)).toBeNull();
      expect((first as Record<string, unknown>).polluted).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
