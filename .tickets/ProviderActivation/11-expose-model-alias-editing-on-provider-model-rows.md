# 11 — Expose Model name editing directly on Provider model rows

**What to build:** Every known model row shows its already-assigned effective Model name and gives the user a small Rename interaction scoped to that model, with an option to restore the default. Normal users never see Alias terminology, canonical target selection, or raw alias-file mechanics.

**Blocked by:** 08 — Add model-scoped alias override and reset operations; 09 — Turn Providers into a real Provider browser.

**Status:** ready-for-agent

- [ ] Add fake-Desktop-API RED tests proving every projected model row displays one current effective Model name before the user configures anything.
- [ ] A model row exposes Rename; a model with a custom override also exposes Restore default.
- [ ] The editor is opened from a concrete model row, fixes the `${providerId}/` prefix, and asks only for the slash-free Model name suffix; it contains no Provider selector, model selector, canonical target editor, or raw JSON/file editing.
- [ ] Saving calls the target-scoped Alias mutation using the model identity already supplied by authoritative Catalog projection and the current Alias revision.
- [ ] Successful save replaces the displayed default with the custom Model name; reset removes the override and displays the Catalog-derived default Model name again.
- [ ] Conflict, invalid alias, unknown/stale target, and storage failure states are actionable and do not show a locally invented successful alias.
- [ ] Model IDs containing `/` remain canonical secondary identity while their default external Model names are slash-free; Renderer never derives a Model name from canonical `modelId` or reparses alias text to infer canonical identity.
- [ ] If the effective Alias projection is not available for a model, the row shows Model name unavailable and disables Rename rather than guessing from canonical identity.
- [ ] No direct model-aliases file manipulation or whole-registry reconstruction is added to the normal Providers workflow.
