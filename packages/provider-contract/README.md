# `@token/provider-contract`

Token external Provider Packages share this private workspace contract.
The contract is a small construction and loading seam around the existing Pi
`Provider`; it is not a second Provider registry, model catalog, or semantic
IR.

The package exports two subpaths:

- `@token/provider-contract/package` — contract version `1`, host
  capabilities, package creation input, and runtime assertion;
- `@token/provider-contract/diagnostics` — the neutral upstream failure,
  conversion notice, invocation-attempt, and execution-fact types and their
  runtime markers.

Core and every external Provider Package must resolve the same installed
contract package. That shared runtime identity makes diagnostic markers trusted
across the package boundary without leaking provider-native facts into Client
Protocol code.

A Provider Package root module exports a fixed `providerPackage` value:

```ts
export const providerPackage = {
  contractVersion: PROVIDER_PACKAGE_CONTRACT_VERSION,
  createProvider(input: ProviderPackageCreateInput): Provider {
    // Validate input.configuration and return one standard Pi Provider.
  },
} satisfies TokenProviderPackage;
```

The host supplies only `fetch`, `now`, and `createUuid`. Configuration remains
opaque to Core and is validated by the owning package. Import failure, an
invalid export or version, factory failure, an invalid Pi Provider, or a
Provider ID collision fails startup before any external package is registered.
