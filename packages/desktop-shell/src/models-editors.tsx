import { useEffect, useMemo, useState } from "react";

import type {
  ModelsCommand,
  ModelsCommandResult,
  ModelsFileError,
  ModelsFileState,
  ModelsProjection,
} from "@luckytoken/application-control-plane/control-plane";

/**
 * Ticket 08 models.json workspace: one authoritative file, two editors.
 *
 * The structured editor covers every field of the repository-pinned Pi
 * models.json schema (provider/model extension fields included); unknown
 * extension data stays editable JSON and is preserved on every save. The raw
 * editor round-trips the exact bytes. Both save through the same Control
 * Plane models commands with compare-and-swap revisions: a stale revision
 * returns an explicit conflict banner instead of losing updates.
 */

export type ModelsFileErrorKind = ModelsFileError["kind"];

/**
 * A draft bound to the exact authoritative revision it was created from.
 * Saves always submit `baseRevision` (never a newer revision), so a stale
 * draft is rejected by the Control Plane CAS instead of silently
 * overwriting newer content.
 */
export interface ModelsDraft<T> {
  readonly value: T;
  readonly baseRevision: number;
}

/**
 * The exact locally submitted write intent. Re-basing after a successful
 * save is allowed only when the returned authoritative state provably
 * corresponds to this submitted intent: same revision step and same
 * content. Any other result (query, conflict, external write, unknown) must
 * never re-base drafts.
 */
export interface SaveIntent {
  readonly kind: "raw" | "structured";
  /** Both drafts' values at submit time, so newer in-flight edits are kept. */
  readonly raw: string;
  readonly providers: Record<string, unknown>;
  readonly baseRevision: number;
}

/**
 * Decide whether a command result re-bases the drafts after a local save.
 * Returns the re-based drafts, or undefined when the result cannot be
 * proven to be the local save's outcome (or is not an ok outcome). Editors
 * whose value changed since the submit keep their newer value; untouched
 * editors adopt the returned authoritative state (raw and structured stay
 * coherent over the same file).
 */
export function applySaveResult(
  intent: SaveIntent,
  providersDraft: ModelsDraft<Record<string, unknown>> | undefined,
  rawDraft: ModelsDraft<string> | undefined,
  result: ModelsCommandResult | undefined,
): {
  readonly providers: ModelsDraft<Record<string, unknown>>;
  readonly raw: ModelsDraft<string>;
} | undefined {
  if (result === undefined || result.outcome !== "ok") return undefined;
  const state = result.state;
  if (state.revision !== intent.baseRevision + 1) return undefined;
  const corresponds =
    intent.kind === "raw"
      ? state.raw === intent.raw
      : JSON.stringify(state.providers) === JSON.stringify(intent.providers);
  if (!corresponds) return undefined;
  return {
    providers: {
      value:
        providersDraft !== undefined &&
        JSON.stringify(providersDraft.value) !==
          JSON.stringify(intent.providers)
          ? providersDraft.value
          : (createProvidersDraft(state) ?? {}),
      baseRevision: state.revision,
    },
    raw: {
      value:
        rawDraft !== undefined && rawDraft.value !== intent.raw
          ? rawDraft.value
          : state.raw,
      baseRevision: state.revision,
    },
  };
}

/**
 * Structured editor draft for an observed authoritative state. The editor
 * must always be able to save: an absent file starts from an empty valid
 * providers record (creating it), an invalid file starts from an empty
 * record too (repairing it with an explicit user save), and a valid file
 * starts from a working copy of its providers. Only an unobserved state
 * (still loading) has no draft.
 */
export function createProvidersDraft(
  state: ModelsFileState | undefined,
): Record<string, unknown> | undefined {
  if (state === undefined) return undefined;
  if (state.present && state.valid && state.providers !== undefined) {
    return structuredClone(state.providers);
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelsCommandErrorLabel(
  result: ModelsCommandResult | undefined,
): { readonly title: string; readonly detail: string } | undefined {
  if (result === undefined) return undefined;
  if (result.outcome === "conflict") {
    // The dedicated conflict row owns the reload action.
    return undefined;
  }
  if (result.outcome === "storage_failure") {
    return {
      title: "The file could not be written",
      detail: result.error?.message ?? "The write failed and the file was left untouched.",
    };
  }
  if (result.outcome === "invalid") {
    return {
      title: "The change was rejected before replacing the file",
      detail:
        result.error?.message ??
        "The proposed content is not valid LuckyToken models.json.",
    };
  }
  return undefined;
}

function FileErrorPanel({ error }: { readonly error: ModelsFileError }) {
  return (
    <div className="models-error" role="alert">
      <strong>models.json is not loadable</strong>
      <p>{error.message}</p>
      {error.location === undefined ? null : (
        <small>
          Line {error.location.line}, column {error.location.column}
          {error.location.position === undefined
            ? ""
            : ` (character ${error.location.position})`}
        </small>
      )}
    </div>
  );
}

function CommandErrorPanel({
  result,
}: {
  readonly result: ModelsCommandResult | undefined;
}) {
  const message = modelsCommandErrorLabel(result);
  if (message === undefined) return null;
  return (
    <div className="models-error" role="alert">
      <strong>{message.title}</strong>
      <p>{message.detail}</p>
    </div>
  );
}

function TextRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly secret?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <label className="models-field">
      <span>{props.label}</span>
      <input
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        type={props.secret === true ? "password" : "text"}
        value={props.value}
      />
    </label>
  );
}

function NumberRow(props: {
  readonly label: string;
  readonly value: number | undefined;
  readonly onChange: (value: number | undefined) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label className="models-field">
      <span>{props.label}</span>
      <input
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(
            event.target.value === "" ? undefined : Number(event.target.value),
          )
        }
        type="number"
        value={props.value === undefined ? "" : String(props.value)}
      />
    </label>
  );
}

function CheckRow(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label className="models-field models-field-check">
      <span>{props.label}</span>
      <input
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  );
}

/** JSON sub-editor for object/array fields: free-form JSON with local parse
 *  feedback; the parsed value only reaches the draft when it is valid JSON. */
function JsonRow(props: {
  readonly label: string;
  readonly value: unknown;
  readonly version: number;
  readonly onChange: (value: unknown) => void;
  readonly disabled?: boolean;
}) {
  const [text, setText] = useState(() =>
    props.value === undefined ? "" : JSON.stringify(props.value, null, 2),
  );
  const [invalid, setInvalid] = useState<string>();
  useEffect(() => {
    setText(
      props.value === undefined ? "" : JSON.stringify(props.value, null, 2),
    );
    setInvalid(undefined);
  }, [props.version]);
  const commit = (next: string) => {
    setText(next);
    if (next.trim() === "") {
      setInvalid(undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      setInvalid(undefined);
      props.onChange(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const position = /position (\d+)/u.exec(message)?.[1];
      setInvalid(
        position === undefined
          ? "Invalid JSON"
          : `Invalid JSON at character ${position}`,
      );
    }
  };
  return (
    <label className="models-field models-field-json">
      <span>{props.label}</span>
      <textarea
        disabled={props.disabled}
        onChange={(event) => commit(event.target.value)}
        rows={Math.min(8, Math.max(3, text.split("\n").length))}
        spellCheck={false}
        value={text}
      />
      {invalid === undefined ? null : <small className="models-invalid">{invalid}</small>}
    </label>
  );
}

function ExtensionRows(props: {
  readonly object: Record<string, unknown>;
  readonly known: ReadonlySet<string>;
  readonly version: number;
  readonly onChange: (object: Record<string, unknown>) => void;
  readonly disabled?: boolean;
}) {
  const extensionKeys = Object.keys(props.object).filter(
    (key) => !props.known.has(key),
  );
  if (extensionKeys.length === 0) return null;
  return (
    <div className="models-extensions">
      {extensionKeys.map((key) => (
        <JsonRow
          disabled={props.disabled ?? false}
          key={key}
          label={`extension: ${key}`}
          onChange={(value) =>
            props.onChange({ ...props.object, [key]: value })
          }
          value={props.object[key]}
          version={props.version}
        />
      ))}
    </div>
  );
}

const providerKnownFields: ReadonlySet<string> = new Set([
  "name",
  "baseUrl",
  "apiKey",
  "api",
  "oauth",
  "headers",
  "compat",
  "authHeader",
  "models",
  "modelOverrides",
]);

const modelKnownFields: ReadonlySet<string> = new Set([
  "id",
  "name",
  "api",
  "baseUrl",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "headers",
  "compat",
]);

function InputTypesRow(props: {
  readonly value: readonly string[] | undefined;
  readonly onChange: (value: string[] | undefined) => void;
  readonly disabled?: boolean;
}) {
  const toggle = (kind: "text" | "image") => {
    const current = props.value ?? ["text"];
    const next = current.includes(kind)
      ? current.filter((entry) => entry !== kind)
      : [...current, kind];
    props.onChange(next.length === 0 ? undefined : next);
  };
  return (
    <div className="models-field models-field-check">
      <span>input</span>
      <span className="models-check-group">
        <label>
          <input
            checked={props.value?.includes("text") ?? true}
            disabled={props.disabled}
            onChange={() => toggle("text")}
            type="checkbox"
          />
          text
        </label>
        <label>
          <input
            checked={props.value?.includes("image") ?? false}
            disabled={props.disabled}
            onChange={() => toggle("image")}
            type="checkbox"
          />
          image
        </label>
      </span>
    </div>
  );
}

interface ModelDraftProps {
  readonly model: Record<string, unknown>;
  readonly version: number;
  readonly disabled?: boolean;
  readonly onChange: (model: Record<string, unknown>) => void;
  readonly onRemove: () => void;
}

function ModelEditor({ model, version, disabled, onChange, onRemove }: ModelDraftProps) {
  const stringValue = (key: string): string =>
    typeof model[key] === "string" ? (model[key] as string) : "";
  const numberValue = (key: string): number | undefined =>
    typeof model[key] === "number" ? (model[key] as number) : undefined;
  const booleanValue = (key: string): boolean => model[key] === true;
  const objectValue = (key: string): unknown => model[key];
  const patch = (key: string, value: unknown) =>
    onChange({ ...model, [key]: value });
  const input = Array.isArray(model.input)
    ? (model.input as string[])
    : undefined;
  return (
    <div className="models-card">
      <div className="models-card-head">
        <strong>{stringValue("id") || "new model"}</strong>
        <button
          disabled={disabled}
          onClick={onRemove}
          type="button"
        >
          Remove
        </button>
      </div>
      <div className="models-grid">
        <TextRow label="id" onChange={(v) => patch("id", v)} value={stringValue("id")} />
        <TextRow label="name" onChange={(v) => patch("name", v)} value={stringValue("name")} />
        <TextRow label="api" onChange={(v) => patch("api", v)} value={stringValue("api")} />
        <TextRow label="baseUrl" onChange={(v) => patch("baseUrl", v)} value={stringValue("baseUrl")} />
        <NumberRow label="contextWindow" onChange={(v) => patch("contextWindow", v)} value={numberValue("contextWindow")} />
        <NumberRow label="maxTokens" onChange={(v) => patch("maxTokens", v)} value={numberValue("maxTokens")} />
        <CheckRow label="reasoning" checked={booleanValue("reasoning")} onChange={(v) => patch("reasoning", v)} />
        <InputTypesRow value={input} onChange={(v) => patch("input", v)} />
      </div>
      <JsonRow label="thinkingLevelMap" onChange={(v) => patch("thinkingLevelMap", v)} value={objectValue("thinkingLevelMap")} version={version} />
      <JsonRow label="cost" onChange={(v) => patch("cost", v)} value={objectValue("cost")} version={version} />
      <JsonRow label="samplingParams" onChange={(v) => patch("samplingParams", v)} value={objectValue("samplingParams")} version={version} />
      <JsonRow label="headers" onChange={(v) => patch("headers", v)} value={objectValue("headers")} version={version} />
      <JsonRow label="compat" onChange={(v) => patch("compat", v)} value={objectValue("compat")} version={version} />
      <ExtensionRows
        disabled={disabled ?? false}
        known={modelKnownFields}
        object={model}
        onChange={onChange}
        version={version}
      />
    </div>
  );
}

interface ProviderDraftProps {
  readonly id: string;
  readonly provider: Record<string, unknown>;
  readonly version: number;
  readonly disabled?: boolean;
  readonly onChange: (id: string, provider: Record<string, unknown>) => void;
  readonly onRemove: () => void;
}

function ProviderEditor({ id, provider, version, disabled, onChange, onRemove }: ProviderDraftProps) {
  const stringValue = (key: string): string =>
    typeof provider[key] === "string" ? (provider[key] as string) : "";
  const booleanValue = (key: string): boolean => provider[key] === true;
  const objectValue = (key: string): unknown => provider[key];
  const patch = (key: string, value: unknown) =>
    onChange(id, { ...provider, [key]: value });
  const models = Array.isArray(provider.models)
    ? (provider.models as Array<Record<string, unknown>>)
    : [];
  const setModels = (next: Array<Record<string, unknown>>) =>
    patch("models", next);
  return (
    <div className="models-card">
      <div className="models-card-head">
        <strong>Provider</strong>
        <button disabled={disabled} onClick={onRemove} type="button">
          Remove
        </button>
      </div>
      <div className="models-grid">
        <TextRow label="id" onChange={(v) => onChange(v, provider)} value={id} />
        <TextRow label="name" onChange={(v) => patch("name", v)} value={stringValue("name")} />
        <TextRow label="api" onChange={(v) => patch("api", v)} value={stringValue("api")} />
        <TextRow label="baseUrl" onChange={(v) => patch("baseUrl", v)} value={stringValue("baseUrl")} />
        <TextRow label="apiKey" onChange={(v) => patch("apiKey", v)} value={stringValue("apiKey")} secret />
        <TextRow label="oauth" onChange={(v) => patch("oauth", v)} value={stringValue("oauth")} />
        <CheckRow label="authHeader" checked={booleanValue("authHeader")} onChange={(v) => patch("authHeader", v)} />
      </div>
      <JsonRow label="headers" onChange={(v) => patch("headers", v)} value={objectValue("headers")} version={version} />
      <JsonRow label="compat" onChange={(v) => patch("compat", v)} value={objectValue("compat")} version={version} />
      <JsonRow label="modelOverrides" onChange={(v) => patch("modelOverrides", v)} value={objectValue("modelOverrides")} version={version} />
      <ExtensionRows
        disabled={disabled ?? false}
        known={providerKnownFields}
        object={provider}
        onChange={(next) => onChange(id, next)}
        version={version}
      />
      <div className="models-subgroup">
        <div className="models-subgroup-head">
          <strong>Models ({models.length})</strong>
          <button
            disabled={disabled}
            onClick={() =>
              setModels([...models, { id: "new-model" }])
            }
            type="button"
          >
            Add model
          </button>
        </div>
        {models.map((model, index) => (
          <ModelEditor
            disabled={disabled ?? false}
            key={`${version}-${index}`}
            model={model}
            onChange={(next) => {
              const updated = [...models];
              updated[index] = next;
              setModels(updated);
            }}
            onRemove={() => setModels(models.filter((_, i) => i !== index))}
            version={version}
          />
        ))}
      </div>
    </div>
  );
}

function StructuredProvidersEditor(props: {
  readonly providers: Record<string, unknown>;
  readonly version: number;
  readonly disabled?: boolean;
  readonly onChange: (providers: Record<string, unknown>) => void;
}) {
  const ids = Object.keys(props.providers);
  return (
    <div className="models-stack">
      {ids.map((id) => (
        <ProviderEditor
          disabled={props.disabled ?? false}
          id={id}
          key={`${props.version}-${id}`}
          onChange={(nextId, nextProvider) => {
            if (nextId === id) {
              props.onChange({
                ...props.providers,
                [id]: nextProvider,
              });
              return;
            }
            const next: Record<string, unknown> = { ...props.providers };
            delete next[id];
            if (nextId.trim() !== "") next[nextId] = nextProvider;
            props.onChange(next);
          }}
          onRemove={() => {
            const next = { ...props.providers };
            delete next[id];
            props.onChange(next);
          }}
          provider={props.providers[id] as Record<string, unknown>}
          version={props.version}
        />
      ))}
      <button
        className="models-add"
        disabled={props.disabled}
        onClick={() =>
          props.onChange({
            ...props.providers,
            "new-provider": {
              baseUrl: "",
              api: "openai-completions",
              models: [],
            },
          })
        }
        type="button"
      >
        + Add provider
      </button>
    </div>
  );
}

interface ModelsPageEditorProps {
  readonly providers: Record<string, unknown>;
  readonly version: number;
  readonly disabled?: boolean;
  readonly onChange: (providers: Record<string, unknown>) => void;
}

/** Models & Aliases page: every model across every provider, one editor. */
function StructuredModelsEditor({ providers, version, disabled, onChange }: ModelsPageEditorProps) {
  const entries = useMemo(() => {
    const result: Array<{
      readonly providerId: string;
      readonly index: number;
      readonly model: Record<string, unknown>;
    }> = [];
    for (const [providerId, raw] of Object.entries(providers)) {
      const provider = isRecord(raw) ? raw : {};
      const models = Array.isArray(provider.models)
        ? (provider.models as Array<Record<string, unknown>>)
        : [];
      models.forEach((model, index) =>
        result.push({ providerId, index, model }),
      );
    }
    return result;
  }, [providers]);
  const [selectedProvider, setSelectedProvider] = useState(
    () => Object.keys(providers)[0] ?? "",
  );
  // The selection must stay valid across reloads: after the providers
  // record changes (e.g. reload onto a newer revision), a removed provider
  // id can never receive a new model.
  const effectiveSelectedProvider = Object.keys(providers).includes(
    selectedProvider,
  )
    ? selectedProvider
    : (Object.keys(providers)[0] ?? "");

  const updateModel = (
    providerId: string,
    index: number,
    model: Record<string, unknown>,
  ) => {
    const next: Record<string, unknown> = { ...providers };
    const provider = isRecord(next[providerId])
      ? { ...(next[providerId] as Record<string, unknown>) }
      : {};
    const models = Array.isArray(provider.models)
      ? [...(provider.models as Array<Record<string, unknown>>)]
      : [];
    models[index] = model;
    next[providerId] = { ...provider, models };
    onChange(next);
  };

  const removeModel = (providerId: string, index: number) => {
    const next: Record<string, unknown> = { ...providers };
    const provider = isRecord(next[providerId])
      ? { ...(next[providerId] as Record<string, unknown>) }
      : {};
    const models = Array.isArray(provider.models)
      ? (provider.models as Array<Record<string, unknown>>)
      : [];
    next[providerId] = { ...provider, models: models.filter((_, i) => i !== index) };
    onChange(next);
  };

  const addModel = () => {
    if (effectiveSelectedProvider === "") return;
    const next: Record<string, unknown> = { ...providers };
    const provider = isRecord(next[effectiveSelectedProvider])
      ? { ...(next[effectiveSelectedProvider] as Record<string, unknown>) }
      : {};
    const models = Array.isArray(provider.models)
      ? [...(provider.models as Array<Record<string, unknown>>)]
      : [];
    next[effectiveSelectedProvider] = {
      ...provider,
      models: [...models, { id: "new-model" }],
    };
    onChange(next);
  };

  if (entries.length === 0) {
    return (
      <div className="models-stack">
        <p className="models-empty">
          No models are configured yet. Add a model to a provider to start.
        </p>
        {Object.keys(providers).length === 0 ? null : (
          <div className="models-add-row">
            <select
              disabled={disabled}
              onChange={(event) => setSelectedProvider(event.target.value)}
              value={effectiveSelectedProvider}
            >
              {Object.keys(providers).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <button disabled={disabled} onClick={addModel} type="button">
              + Add model
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="models-stack">
      {entries.map(({ providerId, index, model }) => (
        <div className="models-card" key={`${version}-${providerId}-${index}`}>
          <div className="models-card-head">
            <strong>{providerId}</strong>
            <button
              disabled={disabled}
              onClick={() => removeModel(providerId, index)}
              type="button"
            >
              Remove model
            </button>
          </div>
          <ModelEditor
            disabled={disabled ?? false}
            model={model}
            onChange={(next) => updateModel(providerId, index, next)}
            onRemove={() => removeModel(providerId, index)}
            version={version}
          />
        </div>
      ))}
      <div className="models-add-row">
        <select
          disabled={disabled}
          onChange={(event) => setSelectedProvider(event.target.value)}
          value={effectiveSelectedProvider}
        >
          {Object.keys(providers).map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button disabled={disabled} onClick={addModel} type="button">
          + Add model
        </button>
      </div>
    </div>
  );
}

export interface ModelsFileWorkspaceProps {
  readonly result: ModelsCommandResult | undefined;
  readonly projection: ModelsProjection | undefined;
  readonly mode: "providers" | "models";
  readonly busy: boolean;
  readonly onCommand: (command: ModelsCommand) => void;
  readonly onReload: () => void;
}

/** One authoritative file, structured and raw editors on the same revision. */
export function ModelsFileWorkspace({
  result,
  projection,
  mode,
  busy,
  onCommand,
  onReload,
}: ModelsFileWorkspaceProps) {
  const [tab, setTab] = useState<"structured" | "raw">("structured");
  // Every draft is bound to the exact authoritative revision its content was
  // created from. A save can never carry a revision newer than its draft
  // content: it always submits the draft's baseRevision, so a stale draft is
  // rejected by the Control Plane CAS instead of silently overwriting a
  // newer file.
  const [providersDraft, setProvidersDraft] = useState<
    ModelsDraft<Record<string, unknown>> | undefined
  >();
  const [rawDraft, setRawDraft] = useState<ModelsDraft<string> | undefined>();
  // The state a pending reload departed from. Drafts stay undefined until a
  // result object other than this stale departure state arrives, so reload
  // re-bases both editors on the fresh query result and never clones the
  // stale pre-query content.
  const [reloadBase, setReloadBase] = useState<ModelsFileState>();
  const [lastSaveRevision, setLastSaveRevision] = useState<number>();
  // The locally submitted write intent plus the result object it was
  // submitted against. A result is considered a fresh outcome only when it
  // is a different object than this reference, so a pre-save result can
  // never be mistaken for the save's outcome.
  const [saveIntent, setSaveIntent] = useState<
    SaveIntent & { readonly resultAtSubmit: ModelsCommandResult | undefined }
  >();

  const state = result?.state;
  const version = state?.revision ?? 0;

  useEffect(() => {
    const intent = saveIntent;
    if (intent === undefined) return;
    if (result === undefined || result === intent.resultAtSubmit) return;
    const rebased = applySaveResult(
      intent,
      providersDraft,
      rawDraft,
      result,
    );
    if (rebased !== undefined) {
      setProvidersDraft(rebased.providers);
      setRawDraft(rebased.raw);
    }
    setSaveIntent(undefined);
  }, [result, saveIntent, providersDraft, rawDraft]);

  useEffect(() => {
    if (
      providersDraft === undefined &&
      rawDraft === undefined &&
      state !== undefined &&
      state !== reloadBase
    ) {
      setProvidersDraft({
        value: createProvidersDraft(state) ?? {},
        baseRevision: state.revision,
      });
      setRawDraft({ value: state.raw, baseRevision: state.revision });
    }
  }, [state, providersDraft, rawDraft, reloadBase]);

  const reload = () => {
    // Discard both drafts and any pending save intent, then wait for the
    // fresh query result: the init effect re-creates the drafts only from a
    // state that is not this departure state, so the stale content can
    // never be re-displayed or re-submitted, and a late save result can
    // never re-base drafts the user has already chosen to discard.
    setSaveIntent(undefined);
    setProvidersDraft(undefined);
    setRawDraft(undefined);
    setReloadBase(state);
    onReload();
  };

  const externalChange =
    projection !== undefined &&
    state !== undefined &&
    projection.revision > state.revision;

  const staleDraft =
    state !== undefined &&
    ((providersDraft !== undefined &&
      providersDraft.baseRevision !== state.revision) ||
      (rawDraft !== undefined && rawDraft.baseRevision !== state.revision));

  const draftsPending =
    state !== undefined &&
    providersDraft === undefined &&
    rawDraft === undefined;

  const updateProvidersDraft = (value: Record<string, unknown>) => {
    setProvidersDraft((current) =>
      current === undefined ? current : { ...current, value },
    );
  };

  const updateRawDraft = (value: string) => {
    setRawDraft((current) =>
      current === undefined ? current : { ...current, value },
    );
  };

  const saveStructured = () => {
    if (providersDraft === undefined) return;
    setLastSaveRevision(providersDraft.baseRevision);
    setSaveIntent({
      kind: "structured",
      raw: rawDraft?.value ?? "",
      providers: providersDraft.value,
      baseRevision: providersDraft.baseRevision,
      resultAtSubmit: result,
    });
    onCommand({
      command: "write_structured",
      revision: providersDraft.baseRevision,
      providers: providersDraft.value,
    });
  };

  const saveRaw = () => {
    if (rawDraft === undefined) return;
    setLastSaveRevision(rawDraft.baseRevision);
    setSaveIntent({
      kind: "raw",
      raw: rawDraft.value,
      providers: providersDraft?.value ?? {},
      baseRevision: rawDraft.baseRevision,
      resultAtSubmit: result,
    });
    onCommand({
      command: "write_raw",
      revision: rawDraft.baseRevision,
      content: rawDraft.value,
    });
  };

  return (
    <section className="models-workspace" aria-label="models.json editor">
      <div className="models-file-card">
        <div>
          <strong>models.json</strong>
          <small>{state === undefined ? "Loading…" : state.path}</small>
        </div>
        <div className="models-file-facts">
          <span className="badge connected">revision {version}</span>
          {state === undefined ? null : state.valid ? (
            <span className="badge connected">
              {state.present ? "valid" : "not created yet"}
            </span>
          ) : (
            <span className="badge error">invalid</span>
          )}
        </div>
      </div>
      {externalChange ? (
        <div className="models-external" role="status">
          The file changed elsewhere (revision {projection?.revision}).{" "}
          <button disabled={busy} onClick={reload} type="button">
            Reload editors
          </button>
        </div>
      ) : null}
      {state !== undefined && !state.valid && state.error !== undefined ? (
        <FileErrorPanel error={state.error} />
      ) : null}
      <CommandErrorPanel result={result} />
      {result?.outcome === "conflict" && !staleDraft ? (
        <div className="models-conflict">
          <button disabled={busy} onClick={reload} type="button">
            Reload current file
          </button>
          <span>
            The draft is kept — reload it onto the current revision before
            saving, or keep editing.
          </span>
        </div>
      ) : null}
      {staleDraft ? (
        <div className="models-conflict" role="alert">
          <strong>
            Draft is based on revision{" "}
            {(providersDraft ?? rawDraft)?.baseRevision}
          </strong>
          <span>
            {" "}
            The file changed to revision {state?.revision}. Saving keeps your
            draft but is rejected as a conflict until it is reloaded onto the
            current revision.
          </span>
          <button disabled={busy} onClick={reload} type="button">
            Reload (discard draft)
          </button>
        </div>
      ) : null}
      {draftsPending ? (
        <p className="models-empty" role="status">
          Loading the current file…
        </p>
      ) : null}
      <div className="models-tabs" role="tablist">
        <button
          className={tab === "structured" ? "active" : ""}
          onClick={() => setTab("structured")}
          type="button"
        >
          Structured editor
        </button>
        <button
          className={tab === "raw" ? "active" : ""}
          onClick={() => setTab("raw")}
          type="button"
        >
          Raw JSON editor
        </button>
      </div>
      {tab === "structured" ? (
        <>
          {mode === "providers" ? (
            <StructuredProvidersEditor
              disabled={busy || draftsPending}
              onChange={updateProvidersDraft}
              providers={providersDraft?.value ?? {}}
              version={version}
            />
          ) : (
            <StructuredModelsEditor
              disabled={busy || draftsPending}
              onChange={updateProvidersDraft}
              providers={providersDraft?.value ?? {}}
              version={version}
            />
          )}
          <div className="models-save-row">
            <button
              className="models-save"
              disabled={busy || providersDraft === undefined}
              onClick={saveStructured}
              type="button"
            >
              {busy ? "Saving…" : "Save structured changes"}
            </button>
            <button disabled={busy} onClick={reload} type="button">
              Reload
            </button>
          </div>
        </>
      ) : (
        <>
          <textarea
            aria-label="models.json raw content"
            className="models-raw"
            disabled={busy || draftsPending}
            onChange={(event) => updateRawDraft(event.target.value)}
            spellCheck={false}
            value={rawDraft?.value ?? ""}
          />
          <div className="models-save-row">
            <button
              className="models-save"
              disabled={busy || rawDraft === undefined}
              onClick={saveRaw}
              type="button"
            >
              {busy ? "Saving…" : "Save raw content"}
            </button>
            <button disabled={busy} onClick={reload} type="button">
              Reload
            </button>
          </div>
        </>
      )}
      {result?.outcome === "ok" &&
      lastSaveRevision !== undefined &&
      result.state.revision >= lastSaveRevision ? (
        <p className="models-saved" role="status">
          Saved at revision {result.state.revision}.
        </p>
      ) : null}
    </section>
  );
}
