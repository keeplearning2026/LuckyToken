import { useEffect, useRef, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";
import type { ProductPage } from "../app/navigation.js";

type BackendStatus = Awaited<ReturnType<LuckyTokenDesktopApi["control"]["getStatus"]>>;

export interface HomePageProps {
  readonly api: LuckyTokenDesktopApi;
  readonly navigate: (page: ProductPage) => void;
}

function attentionTarget(status: BackendStatus): ProductPage {
  const first = status.attention?.conditions[0];
  if (first?.page === "providers") return "providers";
  return "settings";
}

export function HomePage({ api, navigate }: HomePageProps) {
  const [status, setStatus] = useState<BackendStatus>();
  const [unavailable, setUnavailable] = useState(false);
  const [pending, setPending] = useState(false);
  const latestSequence = useRef(-1);

  useEffect(() => {
    let active = true;
    const accept = (next: BackendStatus): void => {
      if (!active || next.sequence < latestSequence.current) return;
      latestSequence.current = next.sequence;
      setUnavailable(false);
      setStatus(next);
    };
    const stop = api.control.onStatus(accept);
    void api.control.getStatus().then(accept, () => {
      if (active && latestSequence.current < 0) setUnavailable(true);
    });
    return () => {
      active = false;
      stop();
    };
  }, [api]);

  const startGateway = async (): Promise<void> => {
    setPending(true);
    try {
      const result = await api.control.executeRuntime("start");
      if (result.snapshot.sequence >= latestSequence.current) {
        latestSequence.current = result.snapshot.sequence;
        setStatus(result.snapshot);
        setUnavailable(false);
      }
    } finally {
      setPending(false);
    }
  };

  if (unavailable) {
    return (
      <section className="hero-card" aria-live="polite">
        <span className="status-dot attention" />
        <p className="eyebrow">CONNECTION</p>
        <h2>LuckyToken is unavailable</h2>
        <p>The local management connection is unavailable. LuckyToken will keep trying to reconnect.</p>
      </section>
    );
  }

  if (status === undefined) {
    return (
      <section className="hero-card" aria-live="polite">
        <span className="status-dot starting" />
        <p className="eyebrow">STARTING</p>
        <h2>Checking LuckyToken…</h2>
        <p>Reading the current Backend state.</p>
      </section>
    );
  }

  if (status.recovery !== undefined) {
    return (
      <section className="hero-card" aria-live="polite">
        <span className="status-dot attention" />
        <p className="eyebrow">RECOVERY</p>
        <h2>Configuration needs repair</h2>
        <p>LuckyToken kept the management plane available and did not start unsafe model-serving state.</p>
        <button type="button" onClick={() => navigate("settings")}>Open settings</button>
      </section>
    );
  }

  if (status.attention?.conditions.length) {
    return (
      <section className="hero-card" aria-live="polite">
        <span className="status-dot attention" />
        <p className="eyebrow">ACTION REQUIRED</p>
        <h2>Needs your attention</h2>
        <p>{status.attention.conditions.length} actionable condition{status.attention.conditions.length === 1 ? "" : "s"} need review.</p>
        <button type="button" onClick={() => navigate(attentionTarget(status))}>Review issue</button>
      </section>
    );
  }

  if (status.provider === "unconfigured") {
    return (
      <section className="hero-card" aria-live="polite">
        <span className="status-dot stopped" />
        <p className="eyebrow">NEXT STEP</p>
        <h2>Connect an AI provider</h2>
        <p>LuckyToken is running locally. Connect a provider before configuring your coding client.</p>
        <button type="button" onClick={() => navigate("providers")}>Set up provider</button>
      </section>
    );
  }

  if (status.modelDataPlane === "starting" || status.modelDataPlane === "stopping") {
    return (
      <section className="hero-card" aria-live="polite">
        <span className="status-dot starting" />
        <p className="eyebrow">GATEWAY</p>
        <h2>Gateway is {status.modelDataPlane === "starting" ? "starting" : "stopping"}</h2>
        <p>LuckyToken will update this page from the authoritative Backend state.</p>
      </section>
    );
  }

  if (status.modelDataPlane === "stopped" || status.modelDataPlane === "failed") {
    return (
      <section className="hero-card" aria-live="polite">
        <span className={`status-dot ${status.modelDataPlane === "failed" ? "attention" : "stopped"}`} />
        <p className="eyebrow">GATEWAY</p>
        <h2>{status.modelDataPlane === "failed" ? "Gateway could not start" : "Gateway is stopped"}</h2>
        <p>{status.dataPlane?.failure?.message ?? "Start the local model gateway when you are ready."}</p>
        <button type="button" disabled={pending} onClick={() => void startGateway()}>
          {pending ? "Starting…" : status.modelDataPlane === "failed" ? "Try again" : "Start gateway"}
        </button>
      </section>
    );
  }

  return (
    <section className="hero-card ready" aria-live="polite">
      <span className="status-dot ready" />
      <p className="eyebrow">READY</p>
      <h2>LuckyToken is ready</h2>
      <p>{status.dataPlane?.configuredOrigin ?? "The local model gateway is running."}</p>
      <button type="button" onClick={() => navigate("connect")}>Connect a client</button>
    </section>
  );
}
