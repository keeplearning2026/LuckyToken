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

  it("replays a linear chain from per-turn deltas in exact order", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: "user-1" },
      completedResponse("resp_1", [{ type: "message", content: "assistant-1" }]),
    );
    await state.remember(
      { input: "user-2", previous_response_id: "resp_1" },
      completedResponse("resp_2", [{ type: "message", content: "assistant-2" }]),
    );

    const expanded = await state.expand({
      model: "m",
      input: "user-3",
      previous_response_id: "resp_2",
    });

    expect(expanded).toMatchObject({
      input: [
        { role: "user", content: "user-1" },
        { type: "message", content: "assistant-1" },
        { role: "user", content: "user-2" },
        { type: "message", content: "assistant-2" },
        { role: "user", content: "user-3" },
      ],
    });
  });

  it("rejects an expanded history that exceeds the item limit", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: Array.from({ length: 600 }, (_, index) => `root-${index}`) },
      completedResponse("resp_1"),
    );
    await state.remember(
      {
        input: Array.from({ length: 600 }, (_, index) => `child-${index}`),
        previous_response_id: "resp_1",
      },
      completedResponse("resp_2"),
    );

    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_2" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
  });

  it("skips checkpoint admission when the resulting history exceeds limits", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: Array.from({ length: 600 }, (_, index) => `root-${index}`) },
      completedResponse("resp_1"),
    );
    const notices: string[] = [];

    await state.remember(
      {
        input: Array.from({ length: 600 }, (_, index) => `child-${index}`),
        previous_response_id: "resp_1",
      },
      completedResponse("resp_2"),
      (code) => notices.push(code),
    );

    expect(state.size()).toBe(1);
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_2" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    expect(notices).toEqual([
      "openai-responses_checkpoint_history_limit_skipped",
    ]);
  });

  it("preflights an oversized candidate before evicting an existing leaf", async () => {
    const { create } = await fixtureState({ maxEntries: 2 });
    const state = create();
    await state.remember({ input: "keep" }, completedResponse("resp_keep"));
    await state.remember({ input: "parent" }, completedResponse("resp_parent"));
    const notices: string[] = [];

    await state.remember(
      {
        input: "x".repeat(300_000),
        previous_response_id: "resp_parent",
      },
      completedResponse("resp_too_large"),
      (code) => notices.push(code),
    );

    expect(state.size()).toBe(2);
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_keep" }),
    ).resolves.toMatchObject({ input: expect.any(Array) });
    expect(notices).toEqual([
      "openai-responses_checkpoint_history_limit_skipped",
    ]);
  });

  it("preserves tool outputs that correlate with a call in an ancestor node", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: "run tool" },
      completedResponse("resp_1", [
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "{}",
        },
      ]),
    );
    await state.remember(
      {
        input: [
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "tool result",
          },
        ],
        previous_response_id: "resp_1",
      },
      completedResponse("resp_2", [
        { type: "message", content: "done" },
      ]),
    );

    const expanded = await state.expand({
      input: "tail",
      previous_response_id: "resp_2",
    });

    expect(expanded).toMatchObject({
      input: expect.arrayContaining([
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "tool result",
        },
      ]),
    });
  });

  it("skips capacity admission when every leaf is on the protected ancestry", async () => {
    const { create } = await fixtureState({ maxEntries: 2 });
    const state = create();
    await state.remember(
      { input: "root" },
      completedResponse("resp_1", [{ type: "message", content: "one" }]),
    );
    await state.remember(
      { input: "child", previous_response_id: "resp_1" },
      completedResponse("resp_2", [{ type: "message", content: "two" }]),
    );
    const notices: string[] = [];

    await state.remember(
      { input: "grandchild", previous_response_id: "resp_2" },
      completedResponse("resp_3", [{ type: "message", content: "three" }]),
      (code) => notices.push(code),
    );

    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_2" }),
    ).resolves.toMatchObject({ input: expect.any(Array) });
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_3" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    expect(notices).toEqual([
      "openai-responses_checkpoint_capacity_skipped",
    ]);
  });

  it("evicts the oldest leaf outside the candidate ancestry", async () => {
    let current = 1;
    const { create } = await fixtureState({ maxEntries: 3, now: () => current });
    const state = create();
    await state.remember({ input: "root" }, completedResponse("resp_root"));
    current += 1;
    await state.remember({ input: "side" }, completedResponse("resp_side"));
    current += 1;
    await state.remember(
      { input: "child", previous_response_id: "resp_root" },
      completedResponse("resp_child"),
    );
    current += 1;

    await state.remember(
      { input: "grandchild", previous_response_id: "resp_child" },
      completedResponse("resp_grandchild"),
    );

    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_grandchild" }),
    ).resolves.toMatchObject({ input: expect.any(Array) });
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_side" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
  });

  it("rejects a duplicate response ID without overwriting its checkpoint", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: "first" },
      completedResponse("resp_duplicate", [
        { type: "message", role: "assistant", content: "first output" },
      ]),
    );

    await expect(
      state.remember(
        { input: "second" },
        completedResponse("resp_duplicate", [
          { type: "message", role: "assistant", content: "second output" },
        ]),
      ),
    ).rejects.toThrow("duplicate Responses response ID");

    const expanded = await state.expand({
      input: "tail",
      previous_response_id: "resp_duplicate",
    });
    expect(expanded).toMatchObject({
      input: [
        { role: "user", content: "first" },
        { type: "message", role: "assistant", content: "first output" },
        { role: "user", content: "tail" },
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
      version: 4,
    });
  });

  it("round-trips an incremental chain through a v4 snapshot", async () => {
    const { stateFile, create } = await fixtureState();
    const first = create();
    await first.remember(
      { input: "root" },
      completedResponse("resp_1", [{ type: "message", content: "one" }]),
    );
    await first.remember(
      { input: "child", previous_response_id: "resp_1" },
      completedResponse("resp_2", [{ type: "message", content: "two" }]),
    );
    await first.flush();

    const second = create();
    const expanded = await second.expand({
      input: "tail",
      previous_response_id: "resp_2",
    });

    expect(expanded).toMatchObject({
      input: [
        { role: "user", content: "root" },
        { type: "message", content: "one" },
        { role: "user", content: "child" },
        { type: "message", content: "two" },
        { role: "user", content: "tail" },
      ],
    });
    const snapshot = JSON.parse(await readFile(stateFile, "utf8"));
    expect(snapshot).toMatchObject({ version: 4 });
    const childNode = snapshot.states.find(
      ([id]: [string, unknown]) => id === "resp_2",
    )?.[1];
    expect(childNode).toMatchObject({
      parentResponseId: "resp_1",
      items: [
        { role: "user", content: "child" },
        { type: "message", content: "two" },
      ],
    });
    expect(JSON.stringify(childNode)).not.toContain("root");
  });

  it("round-trips independent branches through a v4 snapshot", async () => {
    const { create } = await fixtureState();
    const first = create();
    await first.remember({ input: "root" }, completedResponse("resp_root"));
    await first.remember(
      { input: "left", previous_response_id: "resp_root" },
      completedResponse("resp_left"),
    );
    await first.remember(
      { input: "right", previous_response_id: "resp_root" },
      completedResponse("resp_right"),
    );
    await first.flush();

    const second = create();
    await expect(
      second.expand({ input: "tail", previous_response_id: "resp_left" }),
    ).resolves.toMatchObject({
      input: [
        { role: "user", content: "root" },
        { role: "user", content: "left" },
        { role: "user", content: "tail" },
      ],
    });
    await expect(
      second.expand({ input: "tail", previous_response_id: "resp_right" }),
    ).resolves.toMatchObject({
      input: [
        { role: "user", content: "root" },
        { role: "user", content: "right" },
        { role: "user", content: "tail" },
      ],
    });
  });

  it("prunes only leaves when a loaded v4 graph exceeds maxEntries", async () => {
    const { stateFile } = await fixtureState();
    const node = (
      parentResponseId: string | null,
      content: string,
      createdAt: number,
    ) => ({
      createdAt,
      parentResponseId,
      items: [{ role: "user", content }],
    });
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 4,
        states: [
          ["resp_1", node(null, "one", 1)],
          ["resp_2", node("resp_1", "two", 2)],
          ["resp_3", node("resp_2", "three", 3)],
        ],
      }),
      "utf8",
    );
    const state = createResponseSessionState({
      stateFile,
      maxEntries: 2,
      ttlMs: Number.MAX_SAFE_INTEGER,
    });

    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_2" }),
    ).resolves.toMatchObject({ input: expect.any(Array) });
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_3" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    expect(state.size()).toBe(2);
  });

  it.each([
    [
      "duplicate ID",
      [
        ["resp_1", { createdAt: 1, parentResponseId: null, items: [] }],
        ["resp_1", { createdAt: 2, parentResponseId: null, items: [] }],
      ],
    ],
    [
      "missing parent",
      [
        [
          "resp_1",
          { createdAt: 1, parentResponseId: "resp_missing", items: [] },
        ],
      ],
    ],
    [
      "self parent",
      [
        ["resp_1", { createdAt: 1, parentResponseId: "resp_1", items: [] }],
      ],
    ],
    [
      "cycle",
      [
        ["resp_1", { createdAt: 1, parentResponseId: "resp_2", items: [] }],
        ["resp_2", { createdAt: 2, parentResponseId: "resp_1", items: [] }],
      ],
    ],
  ])("quarantines a v4 snapshot with %s", async (_case, states) => {
    const { stateFile, create } = await fixtureState();
    await writeFile(
      stateFile,
      JSON.stringify({ version: 4, states }),
      "utf8",
    );

    const state = create();
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_1" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    const { access } = await import("node:fs/promises");
    await expect(access(`${stateFile}.corrupt`)).resolves.toBeUndefined();
    expect(state.size()).toBe(0);
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

  it("keeps an expired ancestor as an internal replay dependency", async () => {
    let current = 1_000;
    const { create } = await fixtureState({ now: () => current, ttlMs: 100 });
    const state = create();
    await state.remember(
      { input: "root" },
      completedResponse("resp_1", [{ type: "message", content: "one" }]),
    );
    current += 50;
    await state.remember(
      { input: "child", previous_response_id: "resp_1" },
      completedResponse("resp_2", [{ type: "message", content: "two" }]),
    );
    current += 51;

    await expect(
      state.expand({ input: "direct", previous_response_id: "resp_1" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_2" }),
    ).resolves.toMatchObject({
      input: [
        { role: "user", content: "root" },
        { type: "message", content: "one" },
        { role: "user", content: "child" },
        { type: "message", content: "two" },
        { role: "user", content: "tail" },
      ],
    });
  });

  it("collects expired leaves when admitting a new checkpoint", async () => {
    let current = 1_000;
    const { create } = await fixtureState({ now: () => current, ttlMs: 100 });
    const state = create();
    await state.remember({ input: "old" }, completedResponse("resp_old"));
    current += 50;
    await state.remember({ input: "live" }, completedResponse("resp_live"));
    current += 51;

    await state.remember({ input: "new" }, completedResponse("resp_new"));

    expect(state.size()).toBe(2);
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_old" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_live" }),
    ).resolves.toMatchObject({ input: expect.any(Array) });
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

  it("reports a skipped checkpoint when its parent is unavailable", async () => {
    const { create } = await fixtureState();
    const state = create();
    const notices: string[] = [];

    await state.remember(
      { input: "increment", previous_response_id: "resp_missing" },
      completedResponse("resp_child"),
      (code) => notices.push(code),
    );

    expect(state.size()).toBe(0);
    expect(notices).toEqual([
      "openai-responses_checkpoint_parent_unavailable_skipped",
    ]);
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

  it("shares one load barrier across concurrent remember and expand calls", async () => {
    // The handler normally awaits remember. This lower-level interleaving
    // verifies that concurrent Interface calls still publish one coherent
    // in-memory checkpoint after their shared initial load completes.
    const { create } = await fixtureState();
    const state = create();
    const pending = state.remember(
      { input: "racing" },
      completedResponse("resp_race", []),
    );
    // Do not await pending: both operations meet at ensureLoaded().
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

  it("keeps memory checkpoints when the v4 snapshot exceeds 64 MiB", async () => {
    const { stateFile, create } = await fixtureState();
    const state = create();
    const payload = "x".repeat(250_000);
    for (let index = 0; index < 270; index += 1) {
      await state.remember(
        { input: `${index}:${payload}` },
        completedResponse(`resp_large_${index}`),
      );
    }

    await state.flush();

    const { access } = await import("node:fs/promises");
    await expect(access(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.size()).toBe(270);
    await expect(
      state.expand({ input: "tail", previous_response_id: "resp_large_269" }),
    ).resolves.toMatchObject({ input: expect.any(Array) });
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

  it("preserves tool-correlation items without applying storage semantics", async () => {
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
    expect(types).toEqual(["function_call_output", "message", "message"]);
  });

  it("ignores a v3 snapshot without treating it as corruption", async () => {
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
    await expect(
      state.expand({ input: "next", previous_response_id: "resp_legacy" }),
    ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    const { access } = await import("node:fs/promises");
    await expect(access(stateFile)).resolves.toBeUndefined();
    await expect(access(`${stateFile}.corrupt`)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
      [
        "resp_flush",
        {
          createdAt: expect.any(Number),
          parentResponseId: null,
          items: [{ role: "user", content: "flush me" }],
        },
      ],
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

describe("12 recheck: loaded history limits remain request-scoped", () => {
  it("rejects an oversized v4 history without rewriting its payload", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-closed-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      // Hand-written structurally valid snapshot with more history items than
      // a request is allowed to expand.
      const hugeItems = Array.from({ length: 2000 }, (_, i) => ({
        role: "user",
        content: `item-${i}`,
      }));
      await writeFile(
        stateFile,
        JSON.stringify({
          version: 4,
          states: [
            [
              "resp_huge",
              {
                createdAt: Date.now(),
                parentResponseId: null,
                items: hugeItems,
              },
            ],
          ],
        }),
        "utf8",
      );
      const state = createResponseSessionState({ stateFile });
      await expect(
        state.expand({ input: "next", previous_response_id: "resp_huge" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
      await state.flush();
      expect(
        JSON.parse(await readFile(stateFile, "utf8")).states[0][1].items,
      ).toHaveLength(2000);
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

describe("12 recheck: store:false combined with previous_response_id", () => {
  it("store:false=honor bypasses snapshot loading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-sfh-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      await writeFile(stateFile, "{not-json", "utf8");
      const state = createResponseSessionState({
        stateFile,
        storeFalsePolicy: "honor",
      });

      await state.remember(
        { input: "complete request", store: false },
        { id: "resp_stateless", status: "completed", output: [] },
      );

      expect(await readFile(stateFile, "utf8")).toBe("{not-json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("store:false=honor does not save, but prior history still expands", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-sfp-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({ stateFile, storeFalsePolicy: "honor" });
      const complete = (id: string, output: unknown[] = []) => ({ id, status: "completed", output });
      // First turn saved normally.
      await state.remember({ input: "first" }, complete("resp_1"));
      // Second turn: store:false=honor with a valid previous_response_id.
      await state.remember(
        { input: "second", store: false, previous_response_id: "resp_1" },
        complete("resp_2"),
      );
      await state.flush();
      // resp_1 is expandable; resp_2 was not stored.
      expect(await state.expand({ input: "x", previous_response_id: "resp_1" })).toMatchObject({
        input: expect.any(Array),
      });
      await expect(
        state.expand({ input: "x", previous_response_id: "resp_2" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("store:false=memory keeps a chain expandable in-process", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-sfm-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({ stateFile, storeFalsePolicy: "memory" });
      const complete = (id: string, output: unknown[] = []) => ({ id, status: "completed", output });
      await state.remember({ input: "first", store: false }, complete("resp_m1"));
      await state.remember(
        { input: "second", store: false, previous_response_id: "resp_m1" },
        complete("resp_m2"),
      );
      // Chain expands in-process (memory entries are visible), and each node
      // contributes only its own delta.
      const expanded = await state.expand({ input: "tail", previous_response_id: "resp_m2" });
      expect((expanded as { input: unknown[] }).input).toHaveLength(3);
      // Stored items are raw wire items (string input → {role, content}),
      // converted to Pi later; the store keeps them verbatim.
      expect((expanded as { input: unknown[] }).input[0]).toMatchObject({
        role: "user",
        content: "first",
      });
      expect((expanded as { input: unknown[] }).input[1]).toMatchObject({
        role: "user",
        content: "second",
      });
      // Nothing was written to disk.
      const { access } = await import("node:fs/promises");
      await expect(access(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates memory-only storage to persisted-policy descendants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-sfmp-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      const state = createResponseSessionState({
        stateFile,
        storeFalsePolicy: "memory",
      });
      await state.remember(
        { input: "private root", store: false },
        { id: "resp_m1", status: "completed", output: [] },
      );
      await state.remember(
        { input: "child", previous_response_id: "resp_m1" },
        { id: "resp_m2", status: "completed", output: [] },
      );
      await state.flush();

      const { access } = await import("node:fs/promises");
      await expect(access(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        state.expand({ input: "tail", previous_response_id: "resp_m2" }),
      ).resolves.toMatchObject({ input: expect.any(Array) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("12 recheck: snapshot version mismatches are not fail-open", () => {
  it("ignores an unknown future version snapshot (referenced IDs error)", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-ver-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      await writeFile(
        stateFile,
        JSON.stringify({
          version: 99,
          states: [["resp_future", { createdAt: Date.now(), items: [{ role: "user", content: "x" }] }]],
        }),
        "utf8",
      );
      const state = createResponseSessionState({ stateFile });
      await expect(
        state.expand({ input: "x", previous_response_id: "resp_future" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores a missing version field (referenced IDs error, no fail-open)", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-nover-"));
    const stateFile = join(directory, "openai-responses.json");
    try {
      await writeFile(
        stateFile,
        JSON.stringify({
          states: [["resp_nover", { createdAt: Date.now(), items: [{ role: "user", content: "x" }] }]],
        }),
        "utf8",
      );
      const state = createResponseSessionState({ stateFile });
      await expect(
        state.expand({ input: "x", previous_response_id: "resp_nover" }),
      ).rejects.toMatchObject({ kind: "ResponseStateConversionFailure" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
