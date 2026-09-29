/**
 * Provider Native Responses `function-call-namespace-repair`: response-side
 * repair of `function_call` items.
 *
 * Scope: some providers forward a model's namespace child call without the
 * Responses `namespace` field. The Codex caller then resolves the bare child
 * name under the default namespace (`functions`), fails the registry lookup,
 * and answers `unsupported call: <child>`. Token cannot recover that call once
 * the caller has seen the stream, so this module restores the namespace the
 * caller already declared for that child.
 *
 * Authority: the namespace -> child mapping is read from the request body Token
 * already sends upstream. Token does not hardcode any Codex tool table, so MCP
 * servers, plugin namespaces, multi-agent namespaces, and host-provided dynamic
 * namespaces all work from the caller's own declarations.
 *
 * Repair rule: insert `namespace` only when the child name is claimed by exactly
 * one declared namespace and is not also declared as a top-level tool. A child
 * declared under several namespaces (for example `js` under both
 * `mcp__cua_repl` and `mcp__node_repl`) is never repaired, because the intended
 * namespace is not knowable.
 *
 * Byte discipline: every untouched line is preserved verbatim; repaired lines
 * differ only by one inserted `,"namespace":"<name>"` property placed directly
 * after the item's `name` property. Unparsable or unexpected shapes fail open
 * (the original bytes still flow) and are reported by the returned counters.
 */

export interface FunctionCallNamespaceIndex {
  /** Child tool name -> the single declared namespace that claims it. */
  readonly childToNamespace: ReadonlyMap<string, string>;
  readonly declaredNamespaceCount: number;
  readonly ambiguousChildCount: number;
}

export interface FunctionCallNamespaceRepair {
  readonly kind: "repaired" | "unchanged" | "skipped";
  readonly body: string;
  readonly patchedItemCount: number;
  readonly reason?: string;
}

interface PropertySpan {
  readonly key: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  return index;
}

function endOfString(text: string, start: number): number | undefined {
  if (text[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') return index + 1;
  }
  return undefined;
}

function endOfValue(text: string, start: number): number | undefined {
  if (text[start] === '"') return endOfString(text, start);
  const opening = text[start];
  if (opening !== "{" && opening !== "[") {
    let index = start;
    // A scalar also ends at `]`: `enum: [true]` and `required: ["a"]` are the
    // ordinary shapes of a real tool catalog, and stopping only at `,`/`}` made
    // the array walk run past its own terminator and fail the whole index.
    while (
      index < text.length &&
      text[index] !== "," &&
      text[index] !== "}" &&
      text[index] !== "]"
    ) {
      index += 1;
    }
    return index;
  }
  const stack: string[] = [opening === "{" ? "}" : "]"];
  let index = start + 1;
  while (index < text.length && stack.length > 0) {
    const char = text[index]!;
    if (char === '"') {
      const stringEnd = endOfString(text, index);
      if (stringEnd === undefined) return undefined;
      index = stringEnd;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === stack[stack.length - 1]) stack.pop();
    index += 1;
  }
  return stack.length === 0 ? index : undefined;
}

/** Reads the depth-one properties of an object without re-serializing it. */
function objectPropertySpans(
  text: string,
  objectStart: number,
): readonly PropertySpan[] | undefined {
  if (text[objectStart] !== "{") return undefined;
  const spans: PropertySpan[] = [];
  let index = skipWhitespace(text, objectStart + 1);
  while (index < text.length) {
    if (text[index] === "}") return spans;
    const keyStart = index;
    const keyEnd = endOfString(text, keyStart);
    if (keyEnd === undefined) return undefined;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      return undefined;
    }
    if (typeof key !== "string") return undefined;
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") return undefined;
    index = skipWhitespace(text, index + 1);
    const valueStart = index;
    const valueEnd = endOfValue(text, valueStart);
    if (valueEnd === undefined) return undefined;
    spans.push({ key, valueStart, valueEnd });
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    if (text[index] === "}") return spans;
    return undefined;
  }
  return undefined;
}

function uniqueProperty(
  text: string,
  objectStart: number,
  key: string,
): PropertySpan | undefined {
  const spans = objectPropertySpans(text, objectStart);
  if (spans === undefined) return undefined;
  const matches = spans.filter((span) => span.key === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function arrayElementStarts(
  text: string,
  arrayStart: number,
): readonly number[] | undefined {
  if (text[arrayStart] !== "[") return undefined;
  const starts: number[] = [];
  let index = skipWhitespace(text, arrayStart + 1);
  while (index < text.length) {
    if (text[index] === "]") return starts;
    starts.push(index);
    const valueEnd = endOfValue(text, index);
    if (valueEnd === undefined) return undefined;
    index = skipWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    if (text[index] === "]") return starts;
    return undefined;
  }
  return undefined;
}

/**
 * Builds the child -> namespace index from the caller's declared tools.
 * Returns `undefined` when the request does not declare namespaces, so callers
 * can skip the repair entirely.
 */
export function deriveFunctionCallNamespaceIndex(
  requestBodyText: string,
): FunctionCallNamespaceIndex | undefined {
  // The declaration text itself must be unambiguous before it can be authority:
  // a repeated key anywhere inside `tools` is refused rather than parsed with
  // JSON's last-one-wins reading.
  const bodyStart = skipWhitespace(requestBodyText, 0);
  if (requestBodyText[bodyStart] === "{") {
    const topLevel = objectPropertySpans(requestBodyText, bodyStart);
    if (topLevel === undefined) return undefined;
    // Only the authority itself must be unambiguous: a repeated `tools` key has
    // no unique reading, while a repeated unrelated field (say `metadata`) never
    // feeds this module and must not switch the repair off.
    if (topLevel.filter((span) => span.key === "tools").length > 1) {
      return undefined;
    }
    const toolsSpan = uniqueProperty(requestBodyText, bodyStart, "tools");
    if (toolsSpan !== undefined) {
      try {
        assertUniqueKeysDeep(requestBodyText, toolsSpan.valueStart);
      } catch {
        return undefined;
      }
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBodyText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) return undefined;

  const claims = new Map<string, Set<string>>();
  const seenPairs = new Set<string>();
  const conflictedPairs = new Set<string>();
  const topLevelNames = new Set<string>();
  let declaredNamespaceCount = 0;
  for (const entry of parsed.tools) {
    if (!isRecord(entry)) continue;
    if (entry.type === "namespace") {
      const namespace = entry.name;
      if (typeof namespace !== "string" || namespace.length === 0) continue;
      if (!Array.isArray(entry.tools)) continue;
      declaredNamespaceCount += 1;
      for (const child of entry.tools) {
        if (!isRecord(child)) continue;
        if (child.type !== "function" && child.type !== "custom") continue;
        const name = child.name;
        if (typeof name !== "string" || name.length === 0) continue;
        // Only function children can be a repair source: a repaired
        // `function_call` aimed at a custom declaration would dispatch with an
        // incompatible payload, which Codex treats as fatal. A same-named custom
        // child is still evidence — Codex keys tools by `(namespace, name)`
        // alone, so the identity has no unique reading.
        const pair = `${namespace}\u0000${name}`;
        if (seenPairs.has(pair)) conflictedPairs.add(pair);
        seenPairs.add(pair);
        if (child.type !== "function") continue;
        const owners = claims.get(name) ?? new Set<string>();
        owners.add(namespace);
        claims.set(name, owners);
      }
      continue;
    }
    if (entry.type === "function" || entry.type === "custom") {
      const name = entry.name;
      if (typeof name === "string" && name.length > 0) topLevelNames.add(name);
    }
  }
  if (declaredNamespaceCount === 0) return undefined;

  const childToNamespace = new Map<string, string>();
  let ambiguousChildCount = 0;
  for (const [name, owners] of claims) {
    if (owners.size !== 1 || topLevelNames.has(name)) {
      ambiguousChildCount += 1;
      continue;
    }
    const namespace = [...owners][0]!;
    if (conflictedPairs.has(`${namespace}\u0000${name}`)) {
      ambiguousChildCount += 1;
      continue;
    }
    childToNamespace.set(name, namespace);
  }
  return Object.freeze({
    childToNamespace,
    declaredNamespaceCount,
    ambiguousChildCount,
  });
}

interface PayloadPatch {
  readonly text: string;
  readonly patched: number;
}

/** Which location inside a certified payload this module is allowed to touch. */
type RepairCarrier = "item" | "responseOutput" | "bodyOutput";

/** Raised when any part of the body is not the shape this module reasons about.
 * The whole repair is abandoned; the caller keeps the upstream bytes. */
class RepairAbortError extends Error {}

/** A JSON object may not repeat a key; a repeated key means the item shape is
 * not the one this module reasons about, so it is left alone. */
function hasDuplicateKeys(spans: readonly PropertySpan[]): boolean {
  const seen = new Set<string>();
  for (const span of spans) {
    if (seen.has(span.key)) return true;
    seen.add(span.key);
  }
  return false;
}

/** Every object in the declared subtree must be free of repeated keys: a
 * repeated key has no unique reading, so the declaration cannot be authority. */
function assertUniqueKeysDeep(text: string, start: number, depth = 0): void {
  if (depth > 64) throw new RepairAbortError();
  const opening = text[start];
  if (opening === "{") {
    const spans = objectPropertySpans(text, start);
    if (spans === undefined || hasDuplicateKeys(spans)) {
      throw new RepairAbortError();
    }
    for (const span of spans) {
      assertUniqueKeysDeep(text, span.valueStart, depth + 1);
    }
    return;
  }
  if (opening === "[") {
    const elements = arrayElementStarts(text, start);
    if (elements === undefined) throw new RepairAbortError();
    for (const element of elements) {
      assertUniqueKeysDeep(text, element, depth + 1);
    }
  }
}

function patchItemObject(
  text: string,
  itemStart: number,
  index: FunctionCallNamespaceIndex,
): string | undefined {
  const itemEnd = endOfValue(text, itemStart);
  if (itemEnd === undefined) throw new RepairAbortError();
  let item: unknown;
  try {
    item = JSON.parse(text.slice(itemStart, itemEnd));
  } catch {
    throw new RepairAbortError();
  }
  if (!isRecord(item)) throw new RepairAbortError();
  const spans = objectPropertySpans(text, itemStart);
  if (spans === undefined || hasDuplicateKeys(spans)) {
    throw new RepairAbortError();
  }
  if (item.type !== "function_call") return undefined;
  if (typeof item.name !== "string" || item.name.length === 0) {
    throw new RepairAbortError();
  }
  // Only the proven degradation is repaired: a declared function child whose
  // `namespace` field is absent. A present value — right, wrong, empty, or of
  // another type — is never rewritten, and a name that no declaration claims is
  // never interpreted.
  if (item.namespace !== undefined) return undefined;
  const namespace = index.childToNamespace.get(item.name);
  if (namespace === undefined) return undefined;
  const nameSpan = uniqueProperty(text, itemStart, "name");
  if (nameSpan === undefined) throw new RepairAbortError();
  return (
    text.slice(0, nameSpan.valueEnd) +
    `,"namespace":${JSON.stringify(namespace)}` +
    text.slice(nameSpan.valueEnd)
  );
}

function patchPayload(
  payload: string,
  index: FunctionCallNamespaceIndex,
  carrier: RepairCarrier,
): PayloadPatch | undefined {
  const payloadStart = skipWhitespace(payload, 0);
  const payloadSpans = objectPropertySpans(payload, payloadStart);
  if (payloadSpans === undefined || hasDuplicateKeys(payloadSpans)) {
    throw new RepairAbortError();
  }
  // The carrier is bound to the event that claims it. A certified event whose
  // own carrier is missing or malformed abandons the whole repair; no other
  // location in that payload is ever considered.
  if (carrier === "item") {
    const itemSpan = uniqueProperty(payload, payloadStart, "item");
    if (itemSpan === undefined || payload[itemSpan.valueStart] !== "{") {
      throw new RepairAbortError();
    }
    const patched = patchItemObject(payload, itemSpan.valueStart, index);
    return patched === undefined ? undefined : { text: patched, patched: 1 };
  }
  let containerStart = payloadStart;
  if (carrier === "responseOutput") {
    const responseSpan = uniqueProperty(payload, payloadStart, "response");
    if (responseSpan === undefined || payload[responseSpan.valueStart] !== "{") {
      throw new RepairAbortError();
    }
    const responseSpans = objectPropertySpans(payload, responseSpan.valueStart);
    if (responseSpans === undefined || hasDuplicateKeys(responseSpans)) {
      throw new RepairAbortError();
    }
    containerStart = responseSpan.valueStart;
  }
  const outputSpan = uniqueProperty(payload, containerStart, "output");
  if (outputSpan === undefined) {
    return undefined;
  }
  if (payload[outputSpan.valueStart] !== "[") throw new RepairAbortError();
  const starts = arrayElementStarts(payload, outputSpan.valueStart);
  if (starts === undefined) throw new RepairAbortError();
  let patched = payload;
  let count = 0;
  for (let position = starts.length - 1; position >= 0; position -= 1) {
    const patch = patchItemObject(patched, starts[position]!, index);
    if (patch === undefined) continue;
    patched = patch;
    count += 1;
  }
  return count === 0 ? undefined : { text: patched, patched: count };
}

/**
 * Repairs missing `namespace` fields in a fully buffered Provider Native
 * Responses body (SSE or a single JSON body).
 */
export function repairFunctionCallNamespaces(
  body: string,
  index: FunctionCallNamespaceIndex | undefined,
): FunctionCallNamespaceRepair {
  if (index === undefined || index.childToNamespace.size === 0) {
    return Object.freeze({
      kind: "skipped",
      body,
      patchedItemCount: 0,
      reason: "no_unique_declared_namespace_child",
    });
  }
  if (!body.includes("function_call")) {
    return Object.freeze({
      kind: "unchanged",
      body,
      patchedItemCount: 0,
    });
  }

  // A leading byte-order mark must not disqualify a buffered JSON body:
  // `skipWhitespace` treats U+FEFF as whitespace, but `JSON.parse` rejects it.
  const bomOffset = body.startsWith("\uFEFF") ? 1 : 0;
  const bodyStart = skipWhitespace(body, bomOffset);
  if (body[bodyStart] === "{") {
    // A buffered JSON body must parse strictly before any byte is touched.
    try {
      JSON.parse(bomOffset === 0 ? body : body.slice(bomOffset));
    } catch {
      return Object.freeze({ kind: "unchanged", body, patchedItemCount: 0 });
    }
    let patch: PayloadPatch | undefined;
    try {
      patch = patchPayload(
        bomOffset === 0 ? body : body.slice(bomOffset),
        index,
        "bodyOutput",
      );
    } catch (error) {
      // The exported seam owns its fail-open contract; callers must not have to
      // know that an abandoned repair is signalled by an internal error.
      if (error instanceof RepairAbortError) {
        return Object.freeze({ kind: "unchanged", body, patchedItemCount: 0 });
      }
      throw error;
    }
    return patch === undefined
      ? Object.freeze({
          kind: "unchanged",
          body,
          patchedItemCount: 0,
        })
      : Object.freeze({
          kind: "repaired",
          body: `${body.slice(0, bomOffset)}${patch.text}`,
          patchedItemCount: patch.patched,
        });
  }

  let patchedItemCount = 0;
  const lines = body.split("\n");
  try {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const rawLine = lines[lineIndex]!;
      // A leading byte-order mark survives the decode step; strip it only for
      // matching and put it back on write, so the first frame is not skipped.
      const bomPrefix =
        lineIndex === 0 && rawLine.startsWith("\uFEFF") ? "\uFEFF" : "";
      const line = bomPrefix === "" ? rawLine : rawLine.slice(1);
      if (!line.startsWith("data:")) continue;
      let payloadStart = 5;
      while (payloadStart < line.length && line[payloadStart] === " ") {
        payloadStart += 1;
      }
      const payload = line.slice(payloadStart);
      // SSE line endings may be CRLF; the trailing CR is not part of the
      // sentinel, and an empty payload is a keep-alive. Both are benign and
      // must not abandon the repair.
      const sentinel = payload.endsWith("\r") ? payload.slice(0, -1) : payload;
      if (sentinel === "[DONE]" || sentinel.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // Only a payload that looks like a function-call carrier must parse.
        // Anything else — keep-alive text, progress notes — is not a location
        // this module could ever edit, so skipping it cannot hide a partial
        // edit and must not switch the repair off for the whole stream.
        if (payload.includes("function_call")) throw new RepairAbortError();
        continue;
      }
      if (!isRecord(parsed)) continue;
      // Only the certified carriers are rewritten. Any other Responses event
      // stays byte-identical, so a future event type cannot be edited by
      // accident.
      if (
        parsed.type !== "response.output_item.added" &&
        parsed.type !== "response.output_item.done" &&
        parsed.type !== "response.completed"
      ) {
        continue;
      }
      const carrier: RepairCarrier =
        parsed.type === "response.completed" ? "responseOutput" : "item";
      const patch = patchPayload(payload, index, carrier);
      if (patch === undefined) continue;
      patchedItemCount += patch.patched;
      lines[lineIndex] =
        `${bomPrefix}${line.slice(0, payloadStart)}${patch.text}`;
    }
  } catch (error) {
    if (error instanceof RepairAbortError) {
      return Object.freeze({ kind: "unchanged", body, patchedItemCount: 0 });
    }
    throw error;
  }

  if (patchedItemCount === 0) {
    return Object.freeze({
      kind: "unchanged",
      body,
      patchedItemCount: 0,
    });
  }
  return Object.freeze({
    kind: "repaired",
    body: lines.join("\n"),
    patchedItemCount,
  });
}
