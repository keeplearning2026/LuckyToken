import type { Models } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuth } from "../../src/auth.js";
import type {
  InvocationDiagnostics,
  InvocationDiagnosticsFactory,
} from "../../src/invocation-diagnostics/index.js";
import { createAnthropicMessagesHandler } from "../../src/protocols/anthropic/handler.js";
import { createOpenAIResponsesHandler } from "../../src/protocols/openai-responses/handler.js";

function diagnosticsSpy() {
  const succeed = vi.fn(async () => undefined);
  const fail = vi.fn(async () => undefined);
  const invocation: InvocationDiagnostics = {
    requestId: "00000000-0000-4000-8000-000000000099",
    notice: vi.fn(), attempt: vi.fn(), checkpoint: vi.fn(), succeed, fail,
  };
  const begin = vi.fn(() => invocation);
  return {
    factory: { begin } as InvocationDiagnosticsFactory,
    begin, succeed, fail,
  };
}

describe("request-ingress diagnostics lifecycle", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const auth = createAuth({
    authorizeToken: async () => ({}),
    createFallbackSessionId: () => "00000000-0000-4000-8000-000000000001",
  });
  const invalidRequest = () => new Request("https://localhost/v1/test", {
    method: "POST",
    headers: { authorization: "Bearer client", "content-type": "text/plain" },
    body: "not-json",
  });

  it("creates and finalizes one Anthropic failure collector at handler ingress", async () => {
    const spy = diagnosticsSpy();
    const handler = createAnthropicMessagesHandler({
      models: {} as Models, auth, invocationDiagnostics: spy.factory,
      maxRequestBytes: 1024,
    });
    const response = await handler.handle(invalidRequest());
    expect(response.status).toBe(415);
    expect(spy.begin).toHaveBeenCalledOnce();
    expect(spy.begin).toHaveBeenCalledWith("anthropic-messages");
    expect(spy.fail).toHaveBeenCalledWith(expect.objectContaining({ clientStatus: 415 }));
    expect(spy.succeed).not.toHaveBeenCalled();
  });

  it("creates an independent Responses failure collector at its own ingress", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-responses-ingress-"));
    roots.push(root);
    const spy = diagnosticsSpy();
    const handler = createOpenAIResponsesHandler({
      models: {} as Models, auth, invocationDiagnostics: spy.factory,
      stateFile: join(root, "state.json"), maxRequestBytes: 1024,
    });
    const response = await handler.handle(invalidRequest());
    expect(response.status).toBe(415);
    expect(spy.begin).toHaveBeenCalledOnce();
    expect(spy.begin).toHaveBeenCalledWith("openai-responses");
    expect(spy.fail).toHaveBeenCalledWith(expect.objectContaining({ clientStatus: 415 }));
    expect(spy.succeed).not.toHaveBeenCalled();
  });
});
