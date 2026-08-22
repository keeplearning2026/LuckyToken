# `@luckytoken/provider-commandcode-goat`

This private workspace package provides the bundled `commandcode-goat` Pi
Provider. It uses Pi's standard `openai-completions` adapter with the fixed
base URL `https://api.commandcode.ai/provider/v1` and projects the shared
CommandCode model capability catalog under its own Provider identity.

The Provider owns an independent Pi credential slot. It does not import or
reuse CommandCode Private request conversion, credentials, transport, or
response handling.
