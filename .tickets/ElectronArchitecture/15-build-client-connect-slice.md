# 15 — Build Client Connect slice

**What to build:** Give users one Connect workflow that turns an authenticated Provider into a usable supported client integration, starting with Codex, without making users manually traverse tokens, catalog, aliases, and configuration internals.

**Blocked by:** 14 — Build Provider connection slice.

**Status:** completed

- [x] Connect shows supported client integrations and their current readiness using typed Backend/integration facts.
- [x] A user can configure Codex through the product workflow and see whether the integration is enabled and synchronized.
- [x] Required local authentication and model-catalog steps are orchestrated through existing typed capabilities rather than exposed as unrelated engineering pages.
- [x] The workflow can verify the resulting local client configuration and present a clear ready/failure state with an actionable next step.
- [x] The Codex path is fully testable with a fake Desktop API, including incomplete prerequisites, configuration failure, retry, and success.
