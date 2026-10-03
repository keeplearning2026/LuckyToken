import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeCodexTokenOpenai } from "../../scripts/probe-codex-token-openai.mjs";

test("the opt-in probe sends only the selected token to OpenAI, redacts errors and leaves the source intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "Token-openai-probe-fixture-"));
  try {
    const authPath = join(root, "auth.json");
    const access = "fixture-access-secret";
    const refresh = "fixture-refresh-secret";
    const original = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: access, refresh_token: refresh } });
    await writeFile(authPath, original);
    let calls = 0;
    const report = await probeCodexTokenOpenai({ authPath, fetch: async (request, options) => {
      calls += 1;
      assert.equal(request.url, "https://api.openai.com/v1/responses");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), `Bearer ${access}`);
      assert.equal(options.redirect, "error");
      const payload = await request.json();
      assert.equal(payload.model, "gpt-6-luna");
      assert.ok(!JSON.stringify(payload).includes(access));
      assert.ok(!JSON.stringify(payload).includes(refresh));
      return new Response(JSON.stringify({ error: { message: `Rejected ${access} ${refresh}`, type: "invalid_request_error", code: "invalid_token" } }), { status: 401, headers: { "content-type": "application/json" } });
    } });
    assert.equal(calls, 1);
    assert.equal(report.httpStatus, 401);
    assert.equal(report.sourceUnchanged, true);
    assert.equal(report.refreshed, false);
    assert.equal(report.copiedCredentials, false);
    assert.ok(!JSON.stringify(report).includes(access));
    assert.ok(!JSON.stringify(report).includes(refresh));
    assert.ok(report.errorResponse.includes("[redacted]"));
    assert.equal(await readFile(authPath, "utf8"), original);
    await writeFile(authPath, '{"tokens":{"access_token":"fixture-access-secret"}, BROKEN');
    const malformed = await probeCodexTokenOpenai({ authPath, fetch: async () => { throw new Error("must not dispatch"); } });
    assert.equal(malformed.error, "Source credential document is not valid JSON");
    assert.ok(!JSON.stringify(malformed).includes(access));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
