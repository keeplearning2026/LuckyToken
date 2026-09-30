const PREFIX = "anthropic/token-";
const UNIT_WIDTH = 5;

/**
 * The reserved Anthropic client ID keeps the public alias recoverable.
 *
 * Clients that validate configured model names against the Anthropic model
 * catalog drop any name containing another vendor's family token (`deepseek`,
 * `gpt`, `qwen`, ...), which would silently empty a Token-owned picker. The
 * reserved prefix keeps the name Anthropic-shaped, and its payload encodes one
 * UTF-16 code unit per fixed-width decimal group, so no family token can appear
 * and the alias is recoverable for every string a JavaScript value can hold.
 */
export function markAnthropicModelId(alias: string): string {
  let encoded = "";
  for (let index = 0; index < alias.length; index += 1) {
    encoded += alias.charCodeAt(index).toString().padStart(UNIT_WIDTH, "0");
  }
  return `${PREFIX}${encoded}`;
}

/** undefined is an ordinary model ID; null is a reserved ID that names no alias. */
export function unmarkAnthropicModelId(selector: string): string | null | undefined {
  if (!selector.startsWith(PREFIX)) return undefined;
  const encoded = selector.slice(PREFIX.length);
  if (encoded.length === 0 || encoded.length % UNIT_WIDTH !== 0 || !/^[0-9]+$/.test(encoded)) {
    return null;
  }
  let alias = "";
  for (let index = 0; index < encoded.length; index += UNIT_WIDTH) {
    const unit = Number(encoded.slice(index, index + UNIT_WIDTH));
    if (unit > 0xffff) return null;
    alias += String.fromCharCode(unit);
  }
  return alias;
}
