# 05 — Composition registration, configuration, and docs

**What to build:** The OpenAI Responses protocol is optional in configuration;
when present it registers with its own auth file and state file, is documented,
and the full verification suite stays green.

**Blocked by:** 04 — OpenAI Responses handler orchestration.

**Status:** ready-for-agent

- [ ] `clientProtocols["openai-responses"]` accepts `{authFile, stateFile?}`;
  unknown fields are rejected (strict schema); `stateFile` resolves relative to
  the config directory, defaulting to `state/openai-responses.json`.
- [ ] Composition root treats `openai-responses` as installed but optional:
  registered when configured, skipped otherwise; `anthropic-messages` remains
  required; existing configs remain valid.
- [ ] Handler is constructed with its own `Auth` instance and token authority
  from its own auth file (no shared auth state with Anthropic).
- [ ] `luckytoken.config.example.json` and `README.md` document the
  `openai-responses` configuration.
- [ ] `package.json` exports add `./protocols/openai-responses`.
- [ ] Composition integration test: openai-responses registered with independent
  auth/state files; Anthropic tokens rejected on the Responses route and vice
  versa; existing Anthropic composition tests still pass.
- [ ] `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build` all pass.

**Out of scope:** serving certification manifest changes (openai-responses is
outside the certified Anthropic+CommandCode route).
