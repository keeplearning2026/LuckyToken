# `@luckytoken/commandcode-model-catalog`

This private workspace package owns the stable CommandCode model capability
facts shared by LuckyToken's CommandCode Pi Providers: model identity, display
name, context window, input modalities, reasoning support/efforts, and output
limits.

It deliberately does not contain pricing. Pi requires every `Model` to carry a
`cost` object, so the catalog projection supplies zero rates to mean that
LuckyToken does not track price for these models. The zeros are not a claim
that the upstream service is free.

The package owns no Provider identity, authentication, transport, wire
conversion, or request lifecycle. Callers project the capability catalog into
their own `provider`, `api`, and `baseUrl` facts through
`createCommandCodeModelCatalog()`.
