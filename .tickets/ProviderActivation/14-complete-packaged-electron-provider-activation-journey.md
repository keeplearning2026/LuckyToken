# 14 — Complete the packaged Electron Provider activation journey

**What to build:** A fresh packaged LuckyToken product can complete the real activation flow end to end: discover Providers, authenticate while the Gateway is stopped, edit a model alias, start serving, make a successful request through the chosen alias, and observe that request in Activity.

**Blocked by:** 06 — Derive product Provider readiness from real model availability; 10 — Complete generic Provider authentication in the product UI; 11 — Expose model alias editing directly on Provider model rows; 12 — Use the effective alias everywhere clients discover and select models; 13 — Certify request isolation across login, catalog refresh, and alias changes.

**Status:** ready-for-agent

- [ ] Launch the actually packaged Electron product in isolated fresh user state and assert the Providers page contains CommandCode Private plus the authoritative Pi built-in Provider coverage.
- [ ] Stop or deterministically fail the Data Plane and prove Provider discovery, Auth query, Catalog query, and the visible Providers product surface remain usable.
- [ ] Complete a deterministic Provider-owned login interaction through the real Electron Main/preload/Control Plane/Backend path while the Data Plane is stopped; the test must not require an external account or network credential.
- [ ] Expand a real model row and observe its generated `${providerId}/${defaultModelName}` identity before any user rename configuration.
- [ ] Use the model-row Rename action to save a custom slash-free Model name and verify the authoritative UI state changes without exposing Alias/target/file internals.
- [ ] Start the Data Plane without restarting the Backend and send a real deterministic request using the custom alias through the production protocol/Provider execution path.
- [ ] Open Activity and verify the successful request appears through the real ledger projection.
- [ ] Close/reopen the management UI during the journey where useful and prove Provider credential, Catalog, and alias state come from the Backend rather than renderer persistence.
- [ ] Test cleanup leaves no packaged Electron/Backend process residue or mutated real-user state.
