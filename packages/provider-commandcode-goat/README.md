# `@token/provider-commandcode-goat`

This private workspace package provides the bundled `commandcode-goat` Pi
Provider. It projects the shared startup CommandCode catalog facts whose minimum
plan is Go or GOAT under its own Provider identity; the current bundled
bootstrap yields 39 Goat-visible models. Each model's selected API comes from
`supportedEndpoints`: Responses and Chat Completions are active today, and Pi
Anthropic Messages is pre-registered so a future Go/GOAT Messages model can be
enabled by editing `commandcode-models.json` and restarting without rebuilding
the package. OpenAI-style models use
`https://api.commandcode.ai/provider/v1`; Anthropic-style models use the
provider root and let Pi append `/v1/messages`.

The Provider owns an independent Pi credential slot. It does not import or
reuse CommandCode Private request conversion, credentials, transport, or
response handling.

The package root exports only the versioned `providerPackage` registration
contract. Its concrete Provider factory stays internal, and runtime callers use
the registered Provider exclusively through Pi `Models`.
