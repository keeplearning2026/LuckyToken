const PREFIX = "anthropic/token-";

/** The reserved Anthropic client ID keeps the public alias recoverable. */
export function markAnthropicModelId(alias: string): string {
  return `${PREFIX}${alias}`;
}

/** undefined is an ordinary model ID; null is an empty reserved ID. */
export function unmarkAnthropicModelId(selector: string): string | null | undefined {
  if (!selector.startsWith(PREFIX)) return undefined;
  return selector.length > PREFIX.length ? selector.slice(PREFIX.length) : null;
}
