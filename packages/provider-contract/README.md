# `@token/provider-contract`

Token external Provider Packages share this private workspace contract.
The contract is a small construction and loading seam around the existing Pi
`Provider`; it is not a second Provider registry, model catalog, or semantic
IR.

The package exports these subpaths:

- `@token/provider-contract/package` — contract version `1`, host
  capabilities, package creation input, and runtime assertion;
- `@token/provider-contract/diagnostics` — the neutral upstream failure,
  conversion notice, invocation-attempt, and execution-fact types and their
  runtime markers.
- `@token/provider-contract/usage` — Provider usage capabilities;
- `@token/provider-contract/local-oauth` — the common local OAuth registration
  and external-reference types, without Profile or storage concepts.

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

The host supplies `fetch`, `now`, `createUuid`, and `registerLocalOAuth`. Configuration remains
opaque to Core and is validated by the owning package. Import failure, an
invalid export or version, factory failure, an invalid Pi Provider, or a
Provider ID collision fails startup before any external package is registered.

## Local OAuth

A package adds local OAuth by registering once inside `createProvider()`:

```ts
input.host.registerLocalOAuth({
  providerId: provider.id,
  label: () => "Local account",
  icon: "terminal",
  acquire: async (signal) => {
    signal?.throwIfAborted();
    return { owner: "external", path: absoluteAuthPath };
  },
  read: parseLocalOAuthCredential,
});
```

`acquire` discovers an absolute external-file reference, or returns `null` when
no source is selected. `read` synchronously parses file contents into a Pi
`OAuthCredential`, or returns `undefined` for unsupported/invalid content. These
functions receive no Profile. Token canonicalizes the path, performs bounded
reads, validates the result, and creates/persists the Profile only after success.
Keep labels non-secret. Discovery must run without user interaction, observe
cancellation, complete promptly, and return `null` when no source is available.
Token may invoke the same login operation automatically when the user enables
automatic local OAuth connection; registration alone never creates a Profile.

Token implements local OAuth `modify` as a fresh read with the same parser. It
never executes Pi's mutation callback, writes/copies/deletes the external file,
or refreshes credentials on behalf of the external owner.

Registration is allowed only for the package's own Provider, once, while
`createProvider()` is active. All package registrations are staged and discarded
on load failure. At restart the package registers its functions again; existing
Profiles identify the parser by Provider and `local_oauth`. If the registration
is missing, Profiles remain visible and credential use fails closed.
