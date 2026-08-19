/**
 * Per-API terminal usage semantics declarations (Ticket 20) — the Provider
 * integration side's explicit statement of whether terminal usage exists on
 * a `done` terminal and whether all four canonical component meanings
 * (input, cacheRead, cacheWrite, output) are validated by the pinned
 * adapter.
 *
 * Every row is anchored to vendored `pi-agent/` source (immutable for
 * LuckyToken, HANDOFF §3) or to the CommandCode private provider's own
 * strict commit validation. An api with no row (custom api ids, `pi-messages`
 * passthrough) resolves to `undeclared` and can never be Complete.
 *
 * Completeness eligibility rules applied by the normalizer:
 * - a `defaulted` component (adapter hardcodes a value with no wire source)
 *   blocks Completeness — that includes cacheWrite on google/vertex/mistral
 *   and the OpenAI family where the field only exists on some deployments
 *   and absence is silently coalesced to 0;
 * - an `unproven` input partition (bedrock) blocks Completeness;
 * - all-zero usage on `done` is the IR's absence encoding and is always
 *   Partial (`usage_absent`), never inferred complete from values.
 */
import type {
  UsageComponentSource,
  UsageSemanticsDeclaration,
} from "@luckytoken/provider-contract/usage";

function declaration(entry: UsageSemanticsDeclaration): UsageSemanticsDeclaration {
  return Object.freeze({
    ...entry,
    components: Object.freeze(entry.components),
    openQuestions: Object.freeze(entry.openQuestions),
  });
}

const reported: UsageComponentSource = "reported";
const derived: UsageComponentSource = "derived";
const defaulted: UsageComponentSource = "defaulted";

/**
 * Vendored adapter file anchors. Line ranges were verified against the
 * vendored `pi-agent/` copy at commit `d6148e3` (v0.84.1).
 */
const ANTHROPIC_USAGE_EVIDENCE =
  "pi-agent/packages/ai/src/api/anthropic-messages.ts:574-586,715-741";
const OPENAI_COMPLETIONS_USAGE_EVIDENCE =
  "pi-agent/packages/ai/src/api/openai-completions.ts:1374-1409";
const OPENAI_RESPONSES_USAGE_EVIDENCE =
  "pi-agent/packages/ai/src/api/openai-responses-shared.ts:533-557";
const BEDROCK_USAGE_EVIDENCE =
  "pi-agent/packages/ai/src/api/bedrock-converse-stream.ts:589-601";
const GOOGLE_GENAI_USAGE_EVIDENCE =
  "pi-agent/packages/ai/src/api/google-generative-ai.ts:225-245";
const GOOGLE_VERTEX_USAGE_EVIDENCE =
  "pi-agent/packages/ai/src/api/google-vertex.ts:243-263";
const MISTRAL_USAGE_EVIDENCE =
  "pi-agent/packages/ai/src/api/mistral-conversations.ts:279-298,339-349";
const FAUX_USAGE_EVIDENCE =
  "pi-agent/packages/ai/src/providers/faux.ts:229-263";
const COMMANDCODE_USAGE_EVIDENCE =
  "packages/provider-commandcode-private/src/semantic.ts:150-270";

/**
 * The one static declaration table. `pi-messages` has no row: its usage is a
 * passthrough of an upstream pi instance whose semantics LuckyToken cannot
 * validate, so it stays Partial (`undeclared_semantics`).
 */
export const USAGE_SEMANTICS_DECLARATIONS: ReadonlyMap<
  string,
  UsageSemanticsDeclaration
> = new Map([
  [
    "anthropic-messages",
    declaration({
      api: "anthropic-messages",
      evidence: ANTHROPIC_USAGE_EVIDENCE,
      // Wire input_tokens excludes cache; the four components are mutually
      // exclusive by the Anthropic usage contract.
      inputIncludesCache: false,
      components: {
        input: reported,
        cacheRead: reported,
        cacheWrite: reported,
        output: reported,
      },
      reasoning: "reported",
      // Anthropic provides no total; the adapter always derives the sum.
      totalTokens: "derived",
      usagePresentOnDone: "required",
      openQuestions: [],
    }),
  ],
  [
    "openai-completions",
    declaration({
      api: "openai-completions",
      evidence: OPENAI_COMPLETIONS_USAGE_EVIDENCE,
      // prompt_tokens includes cached and written tokens; input is derived
      // as max(0, prompt - cacheRead - cacheWrite).
      inputIncludesCache: true,
      components: {
        input: derived,
        cacheRead: derived,
        // OpenAI proper does not document/emit cache_write_tokens; only
        // OpenRouter-family deployments include it, and absence is silently
        // coalesced to 0 — presence is unprovable from the IR.
        cacheWrite: defaulted,
        output: reported,
      },
      reasoning: "reported",
      totalTokens: "derived",
      usagePresentOnDone: "optional",
      openQuestions: [
        "OpenRouter-family deployments may report cache_write_tokens; the IR cannot prove which deployment produced the terminal usage",
      ],
    }),
  ],
  [
    "openai-responses",
    declaration({
      api: "openai-responses",
      evidence: OPENAI_RESPONSES_USAGE_EVIDENCE,
      // Wire input_tokens includes cached and written tokens; input is
      // derived as max(0, input_tokens - cached - write).
      inputIncludesCache: true,
      components: {
        input: derived,
        cacheRead: derived,
        // input_tokens_details.cache_write_tokens exists only on models with
        // explicit prompt cache; absence is silently coalesced to 0.
        cacheWrite: defaulted,
        output: reported,
      },
      reasoning: "reported",
      totalTokens: "wire",
      usagePresentOnDone: "required",
      openQuestions: [
        "cache_write_tokens presence depends on the model/deployment; unprovable from the IR",
      ],
    }),
  ],
  [
    "openai-codex-responses",
    declaration({
      api: "openai-codex-responses",
      evidence: OPENAI_RESPONSES_USAGE_EVIDENCE,
      inputIncludesCache: true,
      components: {
        input: derived,
        cacheRead: derived,
        cacheWrite: defaulted,
        output: reported,
      },
      reasoning: "reported",
      totalTokens: "wire",
      usagePresentOnDone: "required",
      openQuestions: [
        "cache_write_tokens presence depends on the model/deployment; unprovable from the IR",
      ],
    }),
  ],
  [
    "azure-openai-responses",
    declaration({
      api: "azure-openai-responses",
      evidence: OPENAI_RESPONSES_USAGE_EVIDENCE,
      inputIncludesCache: true,
      components: {
        input: derived,
        cacheRead: derived,
        cacheWrite: defaulted,
        output: reported,
      },
      reasoning: "reported",
      totalTokens: "wire",
      usagePresentOnDone: "required",
      openQuestions: [
        "cache_write_tokens presence depends on the model/deployment; unprovable from the IR",
      ],
    }),
  ],
  [
    "mistral-conversations",
    declaration({
      api: "mistral-conversations",
      evidence: MISTRAL_USAGE_EVIDENCE,
      // promptTokens includes cached tokens; input is derived as
      // max(0, promptTokens - cached).
      inputIncludesCache: true,
      components: {
        input: derived,
        cacheRead: derived,
        // No wire source for cache write in the pinned adapter; hardcoded 0.
        cacheWrite: defaulted,
        output: reported,
      },
      reasoning: "unreported",
      totalTokens: "wire-or-derived",
      usagePresentOnDone: "optional",
      openQuestions: [
        "cacheWrite is hardcoded 0 with no wire source",
      ],
    }),
  ],
  [
    "google-generative-ai",
    declaration({
      api: "google-generative-ai",
      evidence: GOOGLE_GENAI_USAGE_EVIDENCE,
      // promptTokenCount includes cached content; input is derived as
      // promptTokenCount - cachedContentTokenCount.
      inputIncludesCache: true,
      components: {
        input: derived,
        cacheRead: reported,
        // No wire source for cache write in the pinned adapter; hardcoded 0.
        cacheWrite: defaulted,
        output: derived,
      },
      reasoning: "reported",
      totalTokens: "wire",
      usagePresentOnDone: "required",
      openQuestions: [
        "cacheWrite is hardcoded 0 with no wire source",
        "whether wire totalTokenCount includes thoughtsTokenCount is unproven",
      ],
    }),
  ],
  [
    "google-vertex",
    declaration({
      api: "google-vertex",
      evidence: GOOGLE_VERTEX_USAGE_EVIDENCE,
      inputIncludesCache: true,
      components: {
        input: derived,
        cacheRead: reported,
        cacheWrite: defaulted,
        output: derived,
      },
      reasoning: "reported",
      totalTokens: "wire",
      usagePresentOnDone: "required",
      openQuestions: [
        "cacheWrite is hardcoded 0 with no wire source",
        "whether wire totalTokenCount includes thoughtsTokenCount is unproven",
      ],
    }),
  ],
  [
    "bedrock-converse-stream",
    declaration({
      api: "bedrock-converse-stream",
      evidence: BEDROCK_USAGE_EVIDENCE,
      // Whether wire inputTokens includes cacheRead/cacheWrite tokens is
      // unproven; the totalTokens fallback (input + output) drops cache.
      inputIncludesCache: "unproven",
      components: {
        input: reported,
        cacheRead: reported,
        cacheWrite: reported,
        output: reported,
      },
      reasoning: "unreported",
      totalTokens: "wire-or-derived",
      usagePresentOnDone: "required",
      openQuestions: [
        "whether Converse inputTokens includes cacheRead/cacheWrite is unproven",
        "totalTokens fallback to input + output drops cache when the wire total is absent",
      ],
    }),
  ],
  [
    "faux",
    declaration({
      api: "faux",
      evidence: FAUX_USAGE_EVIDENCE,
      // Deterministic test provider: input is derived from the serialized
      // prompt minus the cached prefix; cache components simulate a session
      // prompt cache; totalTokens is always the component sum.
      inputIncludesCache: true,
      components: {
        input: derived,
        cacheRead: derived,
        cacheWrite: derived,
        output: derived,
      },
      reasoning: "unreported",
      totalTokens: "derived",
      usagePresentOnDone: "required",
      openQuestions: [],
    }),
  ],
  [
    "commandcode-private",
    declaration({
      api: "commandcode-private",
      evidence: COMMANDCODE_USAGE_EVIDENCE,
      // Online CommandCode evidence proves the direct product components:
      // input = noCacheTokens, cacheRead = cacheReadTokens, output =
      // outputTokens. inputTokens is consistency evidence only; it must equal
      // noCache + cacheRead + explicit/derived-zero cacheWrite. Missing or
      // inconsistent usage degrades instead of failing model semantics.
      inputIncludesCache: true,
      components: {
        input: reported,
        cacheRead: reported,
        cacheWrite: derived,
        output: reported,
      },
      reasoning: "reported",
      totalTokens: "wire-or-derived",
      // finish usage is optional: absent finish usage normalizes to zero
      // usage (a legal case, surfaced as Partial usage_absent).
      usagePresentOnDone: "optional",
      openQuestions: [],
    }),
  ],
]);

/**
 * Resolves the declared usage semantics for one Pi api id. `undefined` means
 * the api has no declaration (custom api ids, `pi-messages` passthrough) and
 * can never produce a Complete snapshot.
 */
export function resolveUsageSemantics(
  api: string,
): UsageSemanticsDeclaration | undefined {
  return USAGE_SEMANTICS_DECLARATIONS.get(api);
}
