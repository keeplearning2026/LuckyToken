# @token/provider-deepseek-anthropic

Token bundled Provider Package for DeepSeek's Anthropic-Messages-compatible
surface (`https://api.deepseek.com/anthropic`).

- Provider id: `deepseek-anthropic`
- Models: `deepseek-flash`, `deepseek-v4-pro`
- API: Pi `anthropic-messages` adapter (`@earendil-works/pi-ai`)
- Auth: `DEEPSEEK_API_KEY` or a stored credential for `deepseek-anthropic`

The model facts are copied from the pinned `@earendil-works/pi-ai@0.87.0`
DeepSeek catalog; `api`, `baseUrl`, `provider`, and the Anthropic-specific
`compat` fields differ. `forceAdaptiveThinking` is enabled so Pi emits
`output_config.effort` (the only pinned-adapter path that carries effort).
See `src/models.ts` for the adaptation notes.
