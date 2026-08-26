import { Fragment, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileJson2,
  FileText,
  LoaderCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "lucide-react";

import {
  formatPercent,
  formatTimestamp,
  formatTokenCount,
  diagnosticArtifactFileName,
  type AnalyticsFilter,
  type AnalyticsSummary,
  type TokenDesktopApi,
  type RequestJourneyRecord,
  type RequestJourneySummary,
} from "../../shared/desktop-api.js";
import {
  loadRequestColumnWidths,
  getRequestColumnStorage,
  REQUEST_COLUMN_DEFINITIONS,
  totalRequestColumnWidth,
} from "./request-column-widths.js";
import { useOverviewReadModel } from "./overview-read-model.js";

interface OverviewFilters {
  readonly from: number;
  readonly to: number;
  readonly provider: string;
  readonly profile: string;
  readonly model: string;
  readonly protocol: string;
  readonly session: string;
  readonly outcome: string;
}

function defaultFilters(): OverviewFilters {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    from: start.getTime(),
    to: end.getTime(),
    provider: "",
    profile: "",
    model: "",
    protocol: "",
    session: "",
    outcome: "",
  };
}

function inputDateTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseInputDateTime(value: string): number | undefined {
  const epochMs = new Date(value).getTime();
  return value.length > 0 && Number.isFinite(epochMs) ? epochMs : undefined;
}

function displayOutcome(outcome: RequestJourneySummary["outcome"]): string {
  return `${outcome.slice(0, 1).toUpperCase()}${outcome.slice(1)}`;
}

function statusTone(record: RequestJourneySummary): string {
  if (record.httpStatus !== undefined) {
    if (record.httpStatus >= 200 && record.httpStatus < 300) return "good";
    if (record.httpStatus >= 300 && record.httpStatus < 400) return "warning";
    return "error";
  }
  if (record.outcome === "running") return "running";
  if (record.outcome === "aborted" || record.outcome === "interrupted") return "warning";
  return record.outcome === "success" ? "good" : "error";
}

function displayStatus(record: RequestJourneySummary): string {
  if (record.httpStatus !== undefined) return String(record.httpStatus);
  return record.outcome === "running" ? "Running" : "—";
}

function formatCompactTokenCount(value: number): string {
  const formatUnit = (scaled: number, unit: string): string =>
    `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(scaled)}${unit}`;
  if (value >= 1_000_000_000) return formatUnit(value / 1_000_000_000, "B");
  if (value >= 1_000_000) return formatUnit(value / 1_000_000, "M");
  if (value >= 1_000) return formatUnit(value / 1_000, "K");
  return formatTokenCount(value);
}

function formatTokenSpeed(value: number): string {
  return `${value.toFixed(1)} t/s`;
}

function UnavailableUsageCell({ message, column }: { readonly message: string; readonly column: string }) {
  return <td className={`request-column request-column-${column}`} title={message} aria-label={message}>—</td>;
}

function RequestUsageCells({ record }: { readonly record: RequestJourneySummary }) {
  if (record.usage === undefined) {
    const message = record.outcome === "running"
      ? "Terminal usage is pending."
      : "Terminal usage was not reported.";
    return <>
      <UnavailableUsageCell column="input" message={message} />
      <UnavailableUsageCell column="cacheRead" message={message} />
      <UnavailableUsageCell column="hit" message={message} />
      <UnavailableUsageCell column="output" message={message} />
      <UnavailableUsageCell column="tokenSpeed" message={message} />
    </>;
  }
  const usage = record.usage;
  const input = formatTokenCount(usage.inputTokens);
  const cacheRead = formatTokenCount(usage.cacheReadTokens);
  const output = formatTokenCount(usage.outputTokens);
  return <>
    <td className="request-column request-column-input" title={input}>{input}</td>
    <td className="request-column request-column-cacheRead" title={cacheRead}>{cacheRead}</td>
    {usage.cacheHitRate === undefined
      ? <UnavailableUsageCell column="hit" message="Cache hit is unavailable because no input or cache-read tokens were reported." />
      : <td className="request-column request-column-hit" title={formatPercent(usage.cacheHitRate)}>{formatPercent(usage.cacheHitRate)}</td>}
    <td className="request-column request-column-output" title={output}>{output}</td>
    {usage.outputTokensPerSecond === undefined
      ? <UnavailableUsageCell column="tokenSpeed" message="Token speed is unavailable because execution timing was incomplete." />
      : <td className="request-column request-column-tokenSpeed" title={formatTokenSpeed(usage.outputTokensPerSecond)}>{formatTokenSpeed(usage.outputTokensPerSecond)}</td>}
  </>;
}

function humanizeDiagnosticName(value: string): string {
  const words = value.replaceAll("_", " ").trim();
  return words.length === 0
    ? "Unknown"
    : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

function displayDiagnosticLocation(
  location: NonNullable<RequestJourneySummary["primaryFailureLocation"]>,
): string {
  const parts = [
    humanizeDiagnosticName(location.phase),
    humanizeDiagnosticName(location.step),
    location.lane === undefined
      ? undefined
      : humanizeDiagnosticName(location.lane),
    location.attempt === undefined ? undefined : `Attempt ${location.attempt}`,
  ];
  return parts.filter((part): part is string => part !== undefined).join(" · ");
}

function displayArtifactBytes(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${formatTokenCount(value)} bytes`;
}

function observationText(
  observation: RequestJourneyRecord["timeline"][number]["observation"],
): { readonly title: string; readonly detail?: string } {
  const withDetail = (
    title: string,
    detail: string | undefined,
  ): { readonly title: string; readonly detail?: string } =>
    detail === undefined ? { title } : { title, detail };
  switch (observation.kind) {
    case "step_entered":
      return { title: `Started ${humanizeDiagnosticName(observation.location.step)}` };
    case "step_completed":
      return withDetail(
        `${humanizeDiagnosticName(observation.location.step)}: ${humanizeDiagnosticName(observation.completion)}`,
        observation.summary ?? observation.protocol,
      );
    case "lane_committed":
      return {
        title: "Execution path selected",
        detail: humanizeDiagnosticName(observation.lane),
      };
    case "model_resolved":
      return {
        title: "Model resolved",
        detail: `${observation.requestedModel} → ${observation.providerId} / ${observation.modelId}`,
      };
    case "request_identity_established":
      return {
        title: "Session identified",
        detail: observation.clientSessionId ?? observation.effectiveSessionId,
      };
    case "profile_attributed":
      return {
        title: "Profile selected",
        detail: `${observation.displayName} · ${observation.profileId}`,
      };
    case "attempt_observed":
      return withDetail(
        `Provider attempt ${observation.attempt}`,
        [
          observation.transition === undefined
            ? undefined
            : humanizeDiagnosticName(observation.transition),
          observation.status === undefined ? undefined : `HTTP ${observation.status}`,
        ].filter((part): part is string => part !== undefined).join(" · ") || undefined,
      );
    case "conversion_notice_observed":
      return {
        title: `${humanizeDiagnosticName(observation.severity)} conversion notice`,
        detail: observation.code,
      };
    case "artifact_observed":
      return {
        title: "Diagnostic capture updated",
        detail: `${humanizeDiagnosticName(observation.artifactKind)} · ${humanizeDiagnosticName(observation.state)}`,
      };
    case "failure_detected":
      return {
        title: observation.role === "primary" ? "Primary failure detected" : "Supporting failure detected",
        detail: observation.safeMessage ?? observation.classification,
      };
    case "work_outcome_committed":
      return {
        title: `Model work ${humanizeDiagnosticName(observation.outcome)}`,
        detail: humanizeDiagnosticName(observation.terminalAuthority),
      };
    case "terminal_usage_observed":
      return { title: "Terminal usage recorded" };
    case "client_response_prepared":
      return withDetail(
        `Client response prepared · HTTP ${observation.status}`,
        observation.mediaType,
      );
    case "handoff_observed":
      return {
        title: `Response handoff ${humanizeDiagnosticName(observation.outcome)}`,
        detail: humanizeDiagnosticName(observation.transport),
      };
  }
}

interface ArtifactOpenState {
  readonly opening: boolean;
  readonly error?: string;
}

const ARTIFACT_TITLES: Readonly<Record<string, string>> = Object.freeze({
  client_request_envelope: "Client request metadata",
  client_request_wire: "Client request body",
  direct_outbound_request_envelope: "Direct upstream request metadata",
  direct_outbound_request_wire: "Direct upstream request body",
  direct_upstream_response_envelope: "Direct upstream response metadata",
  direct_upstream_response_wire: "Direct upstream response body",
  provider_native_outbound_request_envelope: "Provider request metadata",
  provider_native_outbound_request_wire: "Provider request body",
  provider_native_upstream_response_envelope: "Provider response metadata",
  provider_native_upstream_response_wire: "Provider response body",
  provider_native_preserved_response_wire: "Preserved provider response",
  pi_invocation_snapshot: "Pi invocation",
  pi_provider_request_payload: "Provider request body",
  pi_provider_response_metadata: "Provider response metadata",
  pi_provider_response_ir: "Pi decoded provider response",
  pi_terminal_summary: "Pi terminal result",
  client_response_envelope: "Client response metadata",
  client_response_wire: "Client response body",
});

type CaptureStageId =
  | "client-request"
  | "pi-invocation"
  | "provider-request"
  | "provider-response"
  | "execution-result"
  | "client-response"
  | "other";

const CAPTURE_STAGES: readonly Readonly<{
  id: CaptureStageId;
  label: string;
  description: string;
}>[] = Object.freeze([
  { id: "client-request", label: "Client request", description: "What Token received from the client." },
  { id: "pi-invocation", label: "Pi invocation", description: "Semantic Conversion input prepared for Pi." },
  { id: "provider-request", label: "Provider request", description: "What Token or Pi prepared for the upstream Provider." },
  { id: "provider-response", label: "Provider response", description: "What returned from upstream and what Pi could decode." },
  { id: "execution-result", label: "Execution result", description: "Terminal model-execution facts recorded by Pi." },
  { id: "client-response", label: "Client response", description: "What Token prepared to return to the client." },
  { id: "other", label: "Other evidence", description: "Additional lane-owned diagnostic files." },
]);

function captureStage(artifactKind: string): CaptureStageId {
  if (artifactKind.startsWith("client_request_")) return "client-request";
  if (artifactKind === "pi_invocation_snapshot") return "pi-invocation";
  if (
    artifactKind.includes("outbound_request") ||
    artifactKind === "pi_provider_request_payload"
  ) return "provider-request";
  if (
    artifactKind.includes("upstream_response") ||
    artifactKind === "provider_native_preserved_response_wire" ||
    artifactKind.startsWith("pi_provider_response_")
  ) return "provider-response";
  if (artifactKind === "pi_terminal_summary") return "execution-result";
  if (artifactKind.startsWith("client_response_")) return "client-response";
  return "other";
}

function artifactTitle(artifactKind: string): string {
  return ARTIFACT_TITLES[artifactKind] ?? humanizeDiagnosticName(artifactKind);
}

function artifactRedactionLabel(
  redaction: RequestJourneyRecord["artifacts"][number]["redaction"],
): string {
  switch (redaction) {
    case "applied":
      return "Sensitive values redacted";
    case "failed":
      return "Redaction failed";
    case "not_required":
      return "No redaction needed";
  }
}

function ArtifactCaptureList({
  api,
  record,
}: {
  readonly api: TokenDesktopApi;
  readonly record: RequestJourneyRecord;
}) {
  const [openStates, setOpenStates] = useState<Readonly<Record<string, ArtifactOpenState>>>({});
  const openArtifact = async (
    artifact: RequestJourneyRecord["artifacts"][number],
  ): Promise<void> => {
    if (openStates[artifact.artifactId]?.opening === true) return;
    setOpenStates((existing) => ({
      ...existing,
      [artifact.artifactId]: { opening: true },
    }));
    try {
      const response = await api.control.openRequestArtifact({
        requestId: record.requestId,
        artifactId: artifact.artifactId,
      });
      setOpenStates((existing) => ({
        ...existing,
        [artifact.artifactId]: response.outcome === "opened"
          ? { opening: false }
          : { opening: false, error: response.message },
      }));
    } catch {
      setOpenStates((existing) => ({
        ...existing,
        [artifact.artifactId]: {
          opening: false,
          error: "Capture file is unavailable.",
        },
      }));
    }
  };

  if (record.artifacts.length === 0) return <p>No diagnostic captures were recorded.</p>;
  const groups = CAPTURE_STAGES.map((stage) => ({
    ...stage,
    artifacts: record.artifacts.filter(
      (artifact) => captureStage(artifact.artifactKind) === stage.id,
    ),
  })).filter((stage) => stage.artifacts.length > 0);
  return <div className="diagnostic-capture-groups">{groups.map((group) => (
    <section className="diagnostic-capture-group" aria-labelledby={`capture-stage-${group.id}`} key={group.id}>
      <header>
        <div>
          <h4 id={`capture-stage-${group.id}`}>{group.label}</h4>
          <p>{group.description}</p>
        </div>
        <span>{group.artifacts.length} {group.artifacts.length === 1 ? "file" : "files"}</span>
      </header>
      <ul>{group.artifacts.map((artifact) => {
        const state = openStates[artifact.artifactId];
        const readable = (artifact.state === "captured" || artifact.state === "partial") &&
          (artifact.capturedBytes ?? 0) > 0;
        const fileName = diagnosticArtifactFileName(
          artifact.artifactId,
          artifact.mediaType,
        );
        const title = artifactTitle(artifact.artifactKind);
        const isEventStream = artifact.mediaType?.split(";", 1)[0]?.trim().toLowerCase() ===
          "text/event-stream";
        const actionLabel = `Open ${title} (${fileName})`;
        return <li className="diagnostic-capture-item" key={artifact.artifactId}>
          <span className="diagnostic-capture-file-icon" aria-hidden="true">
            {isEventStream ? <FileText size={18} /> : <FileJson2 size={18} />}
          </span>
          <div className="diagnostic-capture-file">
            <div className="diagnostic-capture-file-heading">
              <strong>{title}</strong>
              <span className={`diagnostic-capture-state ${artifact.state}`}>
                {humanizeDiagnosticName(artifact.state)}
              </span>
              {readable ? <button
                type="button"
                className="diagnostic-capture-open"
                aria-label={actionLabel}
                title={actionLabel}
                disabled={state?.opening === true}
                onClick={() => void openArtifact(artifact)}
              >
                {state?.opening === true
                  ? <LoaderCircle className="spinning" size={17} aria-hidden="true" />
                  : <Search size={17} aria-hidden="true" />}
              </button> : null}
            </div>
            <code>{fileName}</code>
            <p>{artifactRedactionLabel(artifact.redaction)}{artifact.truncated ? " · Truncated" : ""}</p>
            <small>{[
              artifact.mediaType,
              displayArtifactBytes(artifact.capturedBytes),
              artifact.reason,
            ].filter((part): part is string => part !== undefined).join(" · ")}</small>
            {state?.error === undefined ? null : <p className="error-text" role="status">{state.error}</p>}
          </div>
        </li>;
      })}</ul>
    </section>
  ))}</div>;
}

function RequestDetailPanel({ api, record }: { readonly api: TokenDesktopApi; readonly record: RequestJourneyRecord }) {
  const primaryFailure = record.incident?.failures.find(
    (entry) => entry.failureId === record.incident?.primaryFailureId,
  );
  const duration = record.closedAt === undefined
    ? "Still running"
    : `${Math.max(0, record.closedAt - record.createdAt)} ms`;
  const responseStatus = record.clientPresentation?.status ?? record.httpStatus;
  const session = record.clientSessionId ?? record.effectiveSessionId;
  const resolvedTarget = record.providerId === undefined && record.realModelId === undefined
    ? undefined
    : `${record.providerId ?? "Unknown provider"} / ${record.realModelId ?? "Unknown model"}`;
  const location = primaryFailure?.location ?? record.primaryFailureLocation;
  const abnormalOutcome =
    record.outcome !== "success" && record.outcome !== "running";
  const stages = [
    {
      label: "Accepted",
      value: `${record.admission.method} ${record.admission.path}`,
      detail: `${humanizeDiagnosticName(record.admission.transport)} · ${formatTimestamp(record.admission.acceptedAt)}`,
      complete: true,
    },
    {
      label: "Routed",
      value: record.protocol ?? "Protocol not recorded",
      detail: `${humanizeDiagnosticName(record.operation)} · ${record.lane === undefined ? "Execution path not recorded" : humanizeDiagnosticName(record.lane)}`,
      complete: record.protocol !== undefined || record.lane !== undefined,
    },
    {
      label: "Targeted",
      value: record.requestedModel ?? "Model alias not recorded",
      detail: resolvedTarget ?? "Resolved target not recorded",
      complete: record.requestedModel !== undefined || resolvedTarget !== undefined,
    },
    {
      label: "Executed",
      value: record.workOutcome === undefined
        ? "Model work outcome not recorded"
        : humanizeDiagnosticName(record.workOutcome.outcome),
      detail: record.workOutcome === undefined
        ? record.profileDisplayName ?? "Profile not recorded"
        : `${humanizeDiagnosticName(record.workOutcome.terminalAuthority)}${record.profileDisplayName === undefined ? "" : ` · ${record.profileDisplayName}`}`,
      complete: record.workOutcome !== undefined,
    },
    {
      label: "Responded",
      value: responseStatus === undefined ? "HTTP status not recorded" : `HTTP ${responseStatus}`,
      detail: record.handoffOutcome === undefined
        ? record.clientPresentation?.mediaType ?? "Response handoff not recorded"
        : `${humanizeDiagnosticName(record.handoffOutcome.outcome)} · ${humanizeDiagnosticName(record.handoffOutcome.transport)}`,
      complete: responseStatus !== undefined || record.handoffOutcome !== undefined,
    },
  ] as const;

  return <div className="request-detail-panel">
    <header className="request-detail-header">
      <div>
        <span>Request result</span>
        <strong className={`overview-status ${statusTone(record)}`}>
          <span aria-hidden="true" />
          {displayOutcome(record.outcome)}
        </strong>
      </div>
      <dl>
        <div><dt>HTTP</dt><dd>{responseStatus ?? "Not recorded"}</dd></div>
        <div><dt>Duration</dt><dd>{duration}</dd></div>
        <div><dt>Diagnostics</dt><dd>{record.completeness === "complete" ? "Complete" : "Degraded"}</dd></div>
      </dl>
    </header>

    {record.completeness === "degraded" ? (
      <p className="request-detail-warning" role="status">
        Some diagnostic facts could not be stored. Missing values are shown as not recorded.
      </p>
    ) : (
      <p className="request-detail-integrity-note">
        Complete means the required diagnostic record was stored; optional Provider facts may still be absent.
      </p>
    )}

    <section className="request-detail-facts" aria-label="Request facts">
      <div><span>Request ID</span><code>{record.requestId}</code></div>
      <div><span>Session</span><strong>{session ?? "Not recorded"}</strong></div>
      <div><span>Profile</span><strong>{record.profileDisplayName ?? "Not recorded"}</strong><small>{record.profileId}</small></div>
      <div><span>Model target</span><strong>{resolvedTarget ?? "Not recorded"}</strong><small>{record.requestedModel}</small></div>
    </section>

    {(primaryFailure !== undefined || abnormalOutcome) ? (
      <section className="request-primary-failure" aria-label="Primary failure">
        <div>
          <span>{record.outcome === "failed" ? "Why this request failed" : "Why this request ended"}</span>
          <h3>{primaryFailure?.safeMessage ?? "No supported primary cause was recorded."}</h3>
          <p>{primaryFailure === undefined
            ? `The terminal outcome is ${record.outcome}, but the diagnostic record does not identify one primary failure.`
            : `${humanizeDiagnosticName(primaryFailure.origin)} source · ${humanizeDiagnosticName(primaryFailure.originPrecision)}`}</p>
        </div>
        <dl>
          <div><dt>Classification</dt><dd><code>{primaryFailure?.classification ?? "Not recorded"}</code></dd></div>
          <div><dt>Detected at</dt><dd>{location === undefined ? "Not recorded" : displayDiagnosticLocation(location)}</dd></div>
        </dl>
      </section>
    ) : null}

    <section className="request-journey" aria-label="Request journey">
      <h3>What happened</h3>
      <ol>{stages.map((stage) => <li className={stage.complete ? "complete" : "unknown"} key={stage.label}>
        <span aria-hidden="true" />
        <div><strong>{stage.label}</strong><p>{stage.value}</p><small>{stage.detail}</small></div>
      </li>)}</ol>
    </section>

    <div className="request-detail-technical">
      <details>
        <summary>Technical timeline <span>{record.timeline.length} events</span></summary>
        <p>These are stored observations in sequence, not inferred causes.</p>
        {record.timeline.length === 0 ? <p>No timeline events were recorded.</p> : (
          <ol>{record.timeline.map((entry) => {
            const text = observationText(entry.observation);
            return <li key={`${entry.sequence}-${entry.observation.kind}`}>
              <time>{`+${Math.max(0, entry.time - record.admission.acceptedAt)} ms`}</time>
              <div><strong>{text.title}</strong>{text.detail === undefined ? null : <p>{text.detail}</p>}<small>{displayDiagnosticLocation(entry.observation.location)}</small></div>
            </li>;
          })}</ol>
        )}
      </details>
      <details>
        <summary>Diagnostic captures <span>{record.artifacts.length}</span></summary>
        <p>Files are grouped by journey stage. Use the magnifier to open one sanitized capture with the system viewer.</p>
        <ArtifactCaptureList api={api} record={record} />
      </details>
    </div>
  </div>;
}

function SummaryCards({ summary }: { readonly summary: AnalyticsSummary | undefined }) {
  const usageCoverage = summary !== undefined && summary.usageRequests < summary.total
    ? `${summary.usageRequests}/${summary.total} requests`
    : undefined;
  const speedCoverage = summary !== undefined && summary.speedRequests < summary.total
    ? `${summary.speedRequests}/${summary.total} requests`
    : undefined;
  const cards = [
    { id: "requests", label: "Requests", value: summary === undefined ? "—" : formatTokenCount(summary.total), exact: summary === undefined ? undefined : formatTokenCount(summary.total), coverage: undefined },
    { id: "input", label: "Input", value: summary === undefined ? "—" : formatCompactTokenCount(summary.inputTokens), exact: summary === undefined ? undefined : formatTokenCount(summary.inputTokens), coverage: usageCoverage },
    { id: "cache-read", label: "Cache read", value: summary === undefined ? "—" : formatCompactTokenCount(summary.cacheReadTokens), exact: summary === undefined ? undefined : formatTokenCount(summary.cacheReadTokens), coverage: usageCoverage },
    { id: "output", label: "Output", value: summary === undefined ? "—" : formatCompactTokenCount(summary.outputTokens), exact: summary === undefined ? undefined : formatTokenCount(summary.outputTokens), coverage: usageCoverage },
    { id: "token-speed", label: "Token speed", value: summary?.outputTokensPerSecond === undefined ? "—" : formatTokenSpeed(summary.outputTokensPerSecond), exact: summary?.outputTokensPerSecond === undefined ? undefined : formatTokenSpeed(summary.outputTokensPerSecond), coverage: speedCoverage },
    { id: "cache-hit", label: "Cache hit", value: summary?.cacheHitRate === undefined ? "—" : formatPercent(summary.cacheHitRate), exact: summary?.cacheHitRate === undefined ? undefined : formatPercent(summary.cacheHitRate), coverage: usageCoverage },
  ] as const;
  return <section className="overview-stats" aria-label="Overview statistics">
    {cards.map((card) => <div className={`overview-stat-card overview-stat-${card.id}`} key={card.id}><span>{card.label}</span><strong title={card.exact}>{card.value}</strong>{card.coverage === undefined ? null : <small>{card.coverage}</small>}</div>)}
  </section>;
}

export function OverviewPage({ api, backendAvailable }: { readonly api: TokenDesktopApi; readonly backendAvailable: boolean }) {
  const [filters, setFilters] = useState<OverviewFilters>(defaultFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [details, setDetails] = useState<Readonly<Record<string, RequestJourneyRecord | "unavailable">>>({});
  const [expandedRequestId, setExpandedRequestId] = useState<string>();
  const [columnWidths] = useState(() => loadRequestColumnWidths(getRequestColumnStorage()));
  const validRange = filters.from < filters.to;
  const analyticsFilters = useMemo<AnalyticsFilter | undefined>(
    () => {
      const value: AnalyticsFilter = {
        ...(filters.provider === "" ? {} : { providers: [filters.provider] }),
        ...(filters.profile === "" ? {} : { profiles: [filters.profile] }),
        ...(filters.model === "" ? {} : { models: [filters.model] }),
        ...(filters.protocol === "" ? {} : { protocols: [filters.protocol] }),
        ...(filters.session === "" ? {} : { sessions: [filters.session] }),
        ...(filters.outcome === "" ? {} : { outcomes: [filters.outcome] }),
      };
      return Object.keys(value).length === 0 ? undefined : value;
    },
    [filters.model, filters.outcome, filters.profile, filters.protocol, filters.provider, filters.session],
  );
  const {
    analyticsUnavailable,
    historyUnavailable,
    options,
    records,
    refresh,
    refreshing,
    summary,
  } = useOverviewReadModel(api, {
    enabled: backendAvailable && validRange,
    from: filters.from,
    to: filters.to,
    ...(analyticsFilters === undefined ? {} : { filters: analyticsFilters }),
  });
  const filteredRecords = useMemo(
    () => records.filter((record) =>
      record.createdAt >= filters.from &&
      record.createdAt < filters.to &&
      (filters.provider === "" || record.providerId === filters.provider) &&
      (filters.profile === "" || record.profileId === filters.profile) &&
      (filters.model === "" || record.realModelId === filters.model) &&
      (filters.protocol === "" || record.protocol === filters.protocol) &&
      (filters.session === "" || record.clientSessionId === filters.session) &&
      (filters.outcome === "" || record.outcome === filters.outcome)),
    [filters.from, filters.model, filters.outcome, filters.profile, filters.protocol, filters.provider, filters.session, filters.to, records],
  );

  const toggleDetails = async (requestId: string): Promise<void> => {
    if (expandedRequestId === requestId) { setExpandedRequestId(undefined); return; }
    setExpandedRequestId(requestId);
    if (details[requestId] !== undefined) return;
    try {
      const response = await api.control.getRequestJourney({ requestId });
      setDetails((current) => ({ ...current, [requestId]: response.outcome === "ok" ? response.result : "unavailable" }));
    } catch {
      setDetails((current) => ({ ...current, [requestId]: "unavailable" }));
    }
  };

  return <div className="overview-page">
    <SummaryCards summary={summary} />
    {analyticsUnavailable ? <p className="error-text">Request analytics are temporarily unavailable.</p> : null}
    <section className="overview-requests" aria-label="Requests">
      <div className="overview-requests-toolbar"><h2>Requests</h2><div className="overview-toolbar-actions"><button type="button" className="overview-filter-toggle" aria-label="Refresh overview" title="Refresh overview" disabled={!backendAvailable || !validRange} onClick={refresh}><RefreshCw className={refreshing ? "rotating" : undefined} size={17} aria-hidden="true" /></button><button type="button" className={`overview-filter-toggle${filtersOpen ? " active" : ""}`} aria-label={filtersOpen ? "Hide overview filters" : "Show overview filters"} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((current) => !current)}><SlidersHorizontal size={17} aria-hidden="true" /></button></div></div>
      {historyUnavailable && records.length > 0 ? <p className="error-text" role="status">Request history is temporarily unavailable. Showing the last successful snapshot.</p> : null}
      {filtersOpen ? <div className="overview-filters" aria-label="Overview filters">
        <label className="overview-filter-field overview-filter-time"><span>From</span><input type="datetime-local" aria-label="From time" value={inputDateTime(filters.from)} onChange={(event) => { const value = parseInputDateTime(event.currentTarget.value); if (value !== undefined) setFilters((current) => ({ ...current, from: value })); }} /></label>
        <label className="overview-filter-field overview-filter-time"><span>To</span><input type="datetime-local" aria-label="To time" value={inputDateTime(filters.to)} onChange={(event) => { const value = parseInputDateTime(event.currentTarget.value); if (value !== undefined) setFilters((current) => ({ ...current, to: value })); }} /></label>
        <label className="overview-filter-field"><span>Provider</span><select aria-label="Provider filter" value={filters.provider} onChange={(event) => { const value = event.currentTarget.value; setFilters((current) => ({ ...current, provider: value })); }}><option value="">All providers</option>{(options?.providers ?? []).map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></label>
        <label className="overview-filter-field"><span>Profile</span><select aria-label="Profile filter" value={filters.profile} onChange={(event) => { const value = event.currentTarget.value; setFilters((current) => ({ ...current, profile: value })); }}><option value="">All profiles</option>{(options?.profiles ?? []).map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.displayName}</option>)}</select></label>
        <label className="overview-filter-field"><span>Model</span><select aria-label="Model filter" value={filters.model} onChange={(event) => { const value = event.currentTarget.value; setFilters((current) => ({ ...current, model: value })); }}><option value="">All models</option>{(options?.models ?? []).map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
        <label className="overview-filter-field"><span>Protocol</span><select aria-label="Protocol filter" value={filters.protocol} onChange={(event) => { const value = event.currentTarget.value; setFilters((current) => ({ ...current, protocol: value })); }}><option value="">All protocols</option>{(options?.protocols ?? []).map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}</select></label>
        <label className="overview-filter-field"><span>Session</span><select aria-label="Session filter" value={filters.session} onChange={(event) => { const value = event.currentTarget.value; setFilters((current) => ({ ...current, session: value })); }}><option value="">All sessions</option>{(options?.sessions ?? []).map((session) => <option key={session} value={session}>{session}</option>)}</select></label>
        <label className="overview-filter-field"><span>Outcome</span><select aria-label="Outcome filter" value={filters.outcome} onChange={(event) => { const value = event.currentTarget.value; setFilters((current) => ({ ...current, outcome: value })); }}><option value="">All outcomes</option>{(options?.outcomes ?? []).map((outcome) => <option key={outcome} value={outcome}>{displayOutcome(outcome as RequestJourneySummary["outcome"])}</option>)}</select></label>
      </div> : null}
      <div className="overview-table-scroll"><table className="overview-request-table" style={{ width: totalRequestColumnWidth(columnWidths) }}>
        <colgroup>{REQUEST_COLUMN_DEFINITIONS.map((column) => <col key={column.id} data-request-column={column.id} style={{ width: columnWidths[column.id] }} />)}</colgroup>
        <thead><tr>{REQUEST_COLUMN_DEFINITIONS.map((column) => <th className={`request-column request-column-${column.id}`} key={column.id} data-request-column-header={column.id}>{column.label}</th>)}</tr></thead>
        <tbody>{historyUnavailable && records.length === 0 ? <tr><td className="overview-empty" colSpan={12}>Request history is temporarily unavailable.</td></tr> : filteredRecords.length === 0 ? <tr><td className="overview-empty" colSpan={12}>No requests</td></tr> : filteredRecords.map((record) => {
          const expanded = expandedRequestId === record.requestId;
          const detail = details[record.requestId];
          const duration = record.closedAt === undefined ? "-" : `${Math.max(0, record.closedAt - record.createdAt)} ms`;
          const startTime = formatTimestamp(record.createdAt);
          const session = record.clientSessionId ?? record.effectiveSessionId ?? "-";
          const protocol = record.protocol ?? "-";
          const model = record.requestedModel ?? "-";
          const status = displayStatus(record);
          return <Fragment key={record.id}>
            <tr data-request-id={record.requestId} className={expanded ? "expanded" : undefined}>
              <td className="request-column request-column-startTime" title={startTime}><button type="button" className="request-disclosure" aria-label={`${expanded ? "Hide" : "Show"} details for request ${record.requestId}`} aria-expanded={expanded} onClick={() => void toggleDetails(record.requestId)}>{expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}<span>{startTime}</span></button></td>
              <td className="request-column request-column-session" title={session}>{session}</td><td className="request-column request-column-requestId" title={record.requestId}><code>{record.requestId}</code></td><td className="request-column request-column-protocol" title={protocol}>{protocol}</td>
              <RequestUsageCells record={record} /><td className="request-column request-column-time" title={duration}>{duration}</td><td className="request-column request-column-model" title={model}>{model}</td><td className="request-column request-column-status" title={status}><span className={`overview-status ${statusTone(record)}`} aria-label={`${status}; request outcome ${displayOutcome(record.outcome)}`}><span aria-hidden="true" />{status}</span></td>
            </tr>
            {expanded ? <tr className="overview-detail-row"><td colSpan={12}>
              {detail === undefined ? <div className="request-detail-loading"><p>Loading request details…</p></div> : detail === "unavailable" ? <div className="request-detail-loading"><p className="error-text">Request details are temporarily unavailable.</p></div> : <RequestDetailPanel api={api} record={detail} />}
            </td></tr> : null}
          </Fragment>;
        })}</tbody>
      </table></div>
    </section>
  </div>;
}
