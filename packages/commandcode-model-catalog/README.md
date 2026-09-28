# `@token/commandcode-model-catalog`

This private workspace package owns the schema, validation, tracked
`commandcode-models.json` authority, and projection helpers for the stable
CommandCode model capability facts shared by Token's CommandCode Pi Providers.
The tracked JSON file is the only bundled model-data authority. The exported
default catalog and compatibility facts are validated frozen views of that same
file; there is no second TypeScript model table. At runtime the user-side
`dirname(config.json)/commandcode-models.json` is loaded once per Backend
startup. The certified Windows installer replaces it with this file on every
install/reinstall; normal Backend startup never overwrites it. A missing file is
seeded from the package. The current authority contains 57 reviewed
callable models from the `command-code@1.32.1` source table after removing
retired entries.

It deliberately does not contain pricing. Pi requires every `Model` to carry a
`cost` object, so the catalog projection supplies zero rates to mean that
Token does not track price for these models. The zeros are not a claim
that the upstream service is free.

The package owns no Provider identity, authentication, transport, wire
conversion, or request lifecycle. `supportedEndpoints` records upstream
standard-endpoint capability. The required `endpoint` selects the standard
endpoint CommandCode Goat projects and must be a member of that capability set;
CommandCode Private does not use it to choose its private API or wire. Callers
project the catalog into their own `provider`, `api`, and `baseUrl` facts
through `projectCommandCodeModel()`. Missing source output limits project to Pi's
required `maxTokens` value of `64_000`. Reasoning without published effort
levels projects every selectable Pi thinking level to `null` so callers cannot
invent upstream support.

Provider Native Responses forwards the caller's `stream_options` to the
upstream Provider. The model catalog contains no per-model policy for this field.
