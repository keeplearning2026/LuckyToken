# 11 — Complete Pi-to-CommandCode request conversion

**What to build:** Turn a supported Pi Provider invocation into one complete, validated CommandCode Private request whose endpoint, headers, config, generation controls, messages, tools, reasoning, and identity follow the frozen conversion contract.

**Blocked by:** 04 — Propagate project identity end to end; 07 — Convert conversation text, images, and history; 08 — Convert and validate tool-use and tool-result turns; 09 — Convert tools, strict semantics, and the frozen schema subset; 10 — Compose closed-world Pi invocation options.

**Status:** complete

- [x] The endpoint is root-resolved from the selected model base URL and remains stable across attempts.
- [x] Pi headers are normalized case-insensitively, null suppression is honored, and CommandCode-reserved headers cannot be overridden by caller headers.
- [x] Authorization comes only from Pi-resolved effective API key; forbidden OAuth headers are absent and OSS provider identity comes only from bound compatibility policy.
- [x] `threadId` and `x-session-id` use one resolved UUID; project config and slug use one project identity.
- [x] Top-level compatibility fields, permission mode, optional mode, and literal `stream=true` satisfy the CommandCode protocol.
- [x] Model, system, messages, tools, max tokens, temperature, and supported reasoning effort follow their frozen mapping and omission rules.
- [x] Unsupported Pi invocation controls are rejected or ignored only as explicitly specified; no client protocol object enters the Provider.
- [x] Final request validation checks CommandCode message ordering, tool coverage, object-shaped inputs, required fields, and model capability.
- [x] A golden request fixture covers text, image, history, parallel tools, reasoning, session, project, and custom ordinary headers.
