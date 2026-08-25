# `@token/commandcode-model-catalog`

This private workspace package owns the stable CommandCode model capability
facts shared by Token's CommandCode Pi Providers: model identity, display
name, context window, input modalities, reasoning support/efforts, and output
limits. The current catalog contains 58 callable models from the
`command-code@1.32.1` source table after removing retired free entries.

It deliberately does not contain pricing. Pi requires every `Model` to carry a
`cost` object, so the catalog projection supplies zero rates to mean that
Token does not track price for these models. The zeros are not a claim
that the upstream service is free.

The package owns no Provider identity, authentication, transport, wire
conversion, or request lifecycle. Callers project the capability catalog into
their own `provider`, `api`, and `baseUrl` facts through
`projectCommandCodeModel()`. Missing source output limits project to Pi's
required `maxTokens` value of `64_000`. Reasoning without published effort
levels projects every selectable Pi thinking level to `null` so callers cannot
invent upstream support.
