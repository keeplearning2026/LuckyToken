# `@luckytoken/provider-commandcode-private`

This private workspace package owns the complete CommandCode Private Pi
Provider capability: its 33-model catalog, Pi IR to CommandCode request
conversion, CommandCode JSONL to Pi event conversion, project snapshot,
attempt/retry lifecycle, and Provider authentication contract.

Configure the installed root package in LuckyToken:

```json
{
  "providerPackages": {
    "@luckytoken/provider-commandcode-private": {
      "conversion": {},
      "request": {},
      "response": {}
    }
  }
}
```

LuckyToken imports the package from `node_modules`, reads the fixed
`providerPackage` export, validates contract version `1`, creates one standard
Pi Provider, and registers it through Pi `Models`. The legacy
`providerAdapters.commandcode-private` configuration is rejected.

The package root exports only:

- `providerPackage`, for generic LuckyToken loading;
- `createCommandCodePrivateProvider` and its option/policy types, for direct Pi
  integration and characterization tests;
- the `ProjectSnapshot` type required by that direct factory.

The model catalog is package-owned; no `models.json` entry is required. A
missing API key does not prevent `serve` from starting. `login` stores the key
through the standard Pi `CredentialStore`, and a real invocation without a
credential fails through the standard Pi authentication path.

Moving this implementation into a package did not change its frozen protocol
conversion, request defaults, wire shape, diagnostics, tool-call correlation,
or atomic streaming behavior.
