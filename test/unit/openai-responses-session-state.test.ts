import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createResponseSessionState } from "../../src/protocols/openai-responses/session-state.js";

describe("OpenAI Responses session state", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function fixtureState(
    options: { now?: () => number; maxEntries?: number } = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-responses-state-"));
    directories.push(directory);
    const stateFile = join(directory, "openai-responses.json");
    return {
      stateFile,
      directory,
      create: () =>
        createResponseSessionState({
          stateFile,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.maxEntries === undefined
            ? {}
            : { maxEntries: options.maxEntries }),
        }),
    };
  }

  const completedResponse = (id: string, output: unknown[]) => ({
    id,
    status: "completed",
    output,
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
      model: "commandcode-private/deepseek/deepseek-v4-flash",
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
      version: 2,
    });
  });

  it("saves regardless of store:false but only for completed or max_output_tokens-incomplete responses", async () => {
    const { create } = await fixtureState();
    const state = create();

    await state.remember(
      { input: "stored", store: false },
      completedResponse("resp_store_false", [{ type: "message", role: "assistant", content: [] }]),
    );
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
        output: [{ type: "message", role: "assistant", content: [] }],
      },
    );
    await state.remember(
      { input: "failed" },
      {
        id: "resp_failed",
        status: "failed",
        output: [],
      },
    );

    expect(await state.expand({ input: "x", previous_response_id: "resp_store_false" })).toMatchObject({
      input: [
        { role: "user", content: "stored" },
        { type: "message", role: "assistant", content: [] },
        { role: "user", content: "x" },
      ],
    });
    expect(await state.expand({ input: "x", previous_response_id: "resp_incomplete_ok" })).toMatchObject({
      input: [
        { role: "user", content: "incomplete-ok" },
        { type: "message", role: "assistant", content: [] },
        { role: "user", content: "x" },
      ],
    });
    const filterExpansion = await state.expand({
      input: "x",
      previous_response_id: "resp_incomplete_filter",
    });
    expect(filterExpansion).toMatchObject({ input: "x" });
    expect(await state.expand({ input: "x", previous_response_id: "resp_failed" })).toMatchObject({
      input: "x",
    });
  });

  it("fails open when previous_response_id is unknown", async () => {
    const { create } = await fixtureState();
    const state = create();
    const body = {
      model: "m",
      input: "increment",
      previous_response_id: "resp_unknown",
    };

    await expect(state.expand(body)).resolves.toBe(body);
  });

  it("never saves a request whose own previous_response_id failed to expand", async () => {
    const { create } = await fixtureState();
    const state = create();
    await state.remember(
      { input: "delta", previous_response_id: "resp_missing" },
      completedResponse("resp_bad_chain", [{ type: "message", role: "assistant", content: [] }]),
    );

    await expect(state.expand({ input: "y", previous_response_id: "resp_bad_chain" })).resolves.toMatchObject({
      input: "y",
    });
  });

  it("evicts oldest entries past the entry cap", async () => {
    const { create } = await fixtureState({ maxEntries: 2 });
    const state = create();

    await state.remember({ input: "one" }, completedResponse("resp_1", []));
    await state.remember({ input: "two" }, completedResponse("resp_2", []));
    await state.remember({ input: "three" }, completedResponse("resp_3", []));

    expect(await state.expand({ input: "x", previous_response_id: "resp_1" })).toMatchObject({ input: "x" });
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
  });

  it("backs up a corrupt snapshot and starts empty", async () => {
    const { stateFile, create } = await fixtureState();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(stateFile, "{ not json", "utf8");

    const state = create();
    await expect(state.expand({ input: "x", previous_response_id: "resp_any" })).resolves.toMatchObject({
      input: "x",
    });
    const { access } = await import("node:fs/promises");
    await expect(access(`${stateFile}.corrupt`)).resolves.toBeUndefined();
  });

  it("cleans up orphan tmp files from dead writers on load", async () => {
    const { directory, stateFile, create } = await fixtureState();
    const { writeFile } = await import("node:fs/promises");
    const orphan = join(directory, "openai-responses.json.999999.1.tmp");
    await writeFile(orphan, "partial", "utf8");
    // Backdate the tmp file beyond the 15-minute grace.
    const { utimes } = await import("node:fs/promises");
    await utimes(orphan, new Date(Date.now() - 20 * 60 * 1000), new Date(Date.now() - 20 * 60 * 1000));

    const state = create();
    await state.expand({ input: "x" });

    const { access } = await import("node:fs/promises");
    await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stateFile).toBe(stateFile);
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
