# @token/provider-deepseek-response

Token bundled Provider Package for DeepSeek's OpenAI-Responses-compatible
surface (`https://api.deepseek.com/responses`).

- Provider id: `deepseek-response`
- Models: `deepseek-flash`, `deepseek-v4-pro`
- API: Pi `openai-responses` adapter (`@earendil-works/pi-ai`)
- Auth: `DEEPSEEK_API_KEY` or a stored credential for `deepseek-response`

The model facts are copied from the pinned `@earendil-works/pi-ai@0.87.0`
DeepSeek catalog; only `api`, `baseUrl`, `provider`, and the
Responses-specific `compat` fields differ. See `src/models.ts` for the
adaptation notes.
