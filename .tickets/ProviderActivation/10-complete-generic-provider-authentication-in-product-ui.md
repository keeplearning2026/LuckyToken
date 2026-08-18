# 10 — Complete generic Provider authentication in the product UI

**What to build:** From the Providers page, users can actually complete each Provider's Pi-owned interactive login flow—API key, OAuth/account, browser/device-code, prompts, progress, and cancellation—without Gateway startup being a prerequisite.

**Blocked by:** 09 — Turn Providers into a real Provider browser.

**Status:** ready-for-agent

- [ ] Add RED product tests for API-key, OAuth/account, auth URL, device code, text/secret/manual-code/select prompt, progress, cancellation, success, and failure states through the typed Desktop API.
- [ ] Authentication buttons are rendered only from projected Pi Provider metadata (`account`, `subscription`, labels, `apiKey`); no Provider-specific renderer branching is introduced.
- [ ] CommandCode Private uses its existing Pi Provider API-key prompt through the same generic interaction components as other Providers.
- [ ] Login succeeds while the Data Plane is stopped, persists through the one Backend credential authority, and updates the Provider card without a Backend restart.
- [ ] Secret prompt values remain one-shot interaction state and never enter status/catalog projections, persistent renderer state, logs, or unrelated UI state.
- [ ] Successful authentication and Catalog refresh are presented as separate facts: a stored credential remains Connected if model refresh subsequently fails.
- [ ] Catalog convergence after login follows Backend-owned refresh/version publication; the Renderer may re-query for responsiveness but does not invent a polling loop or second refresh authority.
- [ ] Existing logout/reconnect behavior continues through the typed credential/auth contracts and preserves unrelated Provider credentials.
