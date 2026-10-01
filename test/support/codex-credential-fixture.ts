/** Synthetic JWT: never derived from any user-owned auth document. */
export function syntheticCodexAccess(label: string): string {
  const payload = { exp: 1_900_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" }, fixture: label };
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
