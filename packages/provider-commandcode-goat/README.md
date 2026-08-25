# `@token/provider-commandcode-goat`

This private workspace package provides the bundled `commandcode-goat` Pi
Provider. It uses Pi's standard `openai-completions` adapter with the fixed
base URL `https://api.commandcode.ai/provider/v1` and projects the shared
CommandCode facts whose minimum plan is Go or GOAT under its own Provider
identity. The resulting 40-model catalog uses `/chat/completions`; it does not
register Anthropic Messages or OpenAI Responses adapters.

The Provider owns an independent Pi credential slot. It does not import or
reuse CommandCode Private request conversion, credentials, transport, or
response handling.
