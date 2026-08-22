/**
 * Neutralize Anthropic SDK credential env vars that can leak from the host
 * shell (e.g. Claude Code sets ANTHROPIC_AUTH_TOKEN).
 *
 * The Anthropic SDK reads these automatically and, when one is present, sends
 * it alongside the explicit apiKey passed by a test. The local server's
 * strict dual-credential check (src/auth.ts parseClientCredential) rejects a
 * request that carries both a Bearer token and a differing x-api-key, which
 * makes otherwise-passing tests fail with a spurious 401. Deleting them here
 * keeps every test hermetic regardless of the caller's environment.
 */
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
