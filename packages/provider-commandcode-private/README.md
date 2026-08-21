# `@luckytoken/provider-commandcode-private`

This private workspace package owns the complete CommandCode Private Pi Provider capability: its 33-model catalog, Pi IR ↔ CommandCode conversion, request preparation, HTTP attempt/retry lifecycle, JSONL assembly, diagnostics, and Provider authentication contract.

## Product composition

CommandCode Private is a **bundled LuckyToken product Provider**. Production LuckyToken discovers and registers it automatically through the standard Provider Package contract.

Users must **not** add this package to `config.providerPackages`:

```text
@luckytoken/provider-commandcode-private
```

That specifier is reserved by the product and explicit user configuration is rejected. `providerPackages` is only for external/user Provider Packages.

The model catalog is package-owned; no `models.json` entry is required. A missing API key does not prevent the Backend from reaching Management Ready. Login/credential operations use the Backend/Pi credential authority, and a real invocation without usable auth fails through the standard Provider authentication path.

## Package contract

LuckyToken loads the bundled package through its fixed `providerPackage` root export, validates the versioned Provider Package contract, creates one standard Pi `Provider`, and registers it through Pi `Models`. Core and Client Protocol modules do not import or special-case the CommandCode implementation.

The package root exports:

- `providerPackage`, for LuckyToken bundled Provider composition;
- `createCommandCodePrivateProvider` and its option/policy types, for direct Pi integration and characterization tests.

Current request construction does **not** derive project/workspace state from Pi metadata. `project.ts` supplies the fixed empty `ServerConfig` required by the current upstream compatibility contract; there is no current `projectDir → project snapshot/x-project-slug` flow.

Moving this implementation into a package does not change its frozen protocol conversion, request defaults, wire shape, diagnostics, tool-call correlation, or atomic streaming behavior.
