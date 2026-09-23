# `@token/provider-commandcode-private`

This private workspace package owns the complete CommandCode Private Pi Provider capability: its projection of the shared CommandCode model capability catalog, Pi IR ↔ CommandCode conversion, request preparation, HTTP attempt/retry lifecycle, JSONL assembly, diagnostics, and Provider authentication contract.

It projects every model from the one frozen startup CommandCode catalog
snapshot; the current bundled bootstrap contains 58 reviewed facts. Reasoning
effort is emitted only after Pi capability clamping produces a supported string;
the Provider does not invent an effort or fall back to the model's highest
advertised level.

## Product composition

CommandCode Private is a **bundled Token product Provider**. Production Token discovers and registers it automatically through the standard Provider Package contract.

Users must **not** add this package to `config.providerPackages`:

```text
@token/provider-commandcode-private
```

That specifier is reserved by the product and explicit user configuration is rejected. `providerPackages` is only for external/user Provider Packages.

The runtime model catalog is loaded once from
`dirname(config.json)/commandcode-models.json` by product startup composition
and injected into the package alongside the package-owned Private
conversion/transport configuration. No `models.json` entry is required. A
missing API key does not prevent the Backend from reaching Management Ready.
Login/credential operations use the Backend/Pi credential authority, and a real
invocation without usable auth fails through the standard Provider
authentication path.

## Package contract

Token loads the bundled package through its fixed `providerPackage` root export, validates the versioned Provider Package contract, creates one standard Pi `Provider`, and registers it through Pi `Models`. Core and Client Protocol modules do not import or special-case the CommandCode implementation.

The package root exports only `providerPackage`, for Token bundled Provider
composition. The concrete factory and its option/policy types remain internal;
white-box Provider tests import their source module directly. Runtime callers
must resolve and invoke this Provider through Pi `Models`.

Current request construction does **not** derive project/workspace state from Pi metadata. `project.ts` supplies the fixed empty `ServerConfig` required by the current upstream compatibility contract; there is no current `projectDir → project snapshot/x-project-slug` flow.

Moving this implementation into a package does not change its frozen protocol conversion, request defaults, wire shape, diagnostics, tool-call correlation, or atomic streaming behavior.
