# 11 — Expose model alias editing directly on Provider model rows

**What to build:** Every known model row shows its already-assigned effective alias and gives the user a small Add/Edit alias interaction scoped to that model, with an option to restore the default. Normal users never see canonical target selection or raw alias-file mechanics.

**Blocked by:** 08 — Add model-scoped alias override and reset operations; 09 — Turn Providers into a real Provider browser.

**Status:** ready-for-agent

- [ ] Add fake-Desktop-API RED tests proving every projected model row displays one current effective alias before the user configures anything.
- [ ] A model using its generated default exposes an accessible Add alias icon/action; a model with a custom override exposes Edit alias and a reset/Use default action.
- [ ] The alias editor is opened from a concrete model row and asks only for the friendly alias value; it contains no Provider selector, model selector, canonical target editor, or raw JSON/file editing.
- [ ] Saving calls the target-scoped Alias mutation using the model identity already supplied by authoritative Catalog projection and the current Alias revision.
- [ ] Successful save replaces the displayed default with the custom effective alias; reset removes the override and displays `providerId/modelId` again.
- [ ] Conflict, invalid alias, unknown/stale target, and storage failure states are actionable and do not show a locally invented successful alias.
- [ ] Model IDs containing `/` render their generated alias exactly and are never reparsed by Renderer code to infer canonical identity.
- [ ] No direct model-aliases file manipulation or whole-registry reconstruction is added to the normal Providers workflow.
