import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

const PROTOCOLS = Object.freeze([
  { id: "anthropic-messages", name: "Anthropic Messages" },
  { id: "openai-responses", name: "OpenAI Responses" },
] as const);

type ProtocolId = (typeof PROTOCOLS)[number]["id"];

interface TokenState {
  readonly revision: number;
  readonly token?: string;
  readonly unavailable?: boolean;
  readonly error?: string;
}

export function ClientAccessSettings({ api }: { readonly api: LuckyTokenDesktopApi }) {
  const [tokens, setTokens] = useState<Partial<Record<ProtocolId, TokenState>>>({});
  const [busy, setBusy] = useState<ProtocolId>();
  const [copied, setCopied] = useState<ProtocolId>();

  const load = async (protocolId: ProtocolId): Promise<void> => {
    const listed = await api.control.executeClientToken({
      command: "list",
      protocolId,
    });
    if (listed.outcome !== "ok") {
      setTokens((current) => ({
        ...current,
        [protocolId]: {
          revision: listed.revision,
          unavailable: true,
          error: listed.error ?? "Client token is unavailable.",
        },
      }));
      return;
    }
    const hasGlobal = listed.scopes?.some((scope) => scope.type === "global") ?? false;
    if (!hasGlobal) {
      setTokens((current) => ({
        ...current,
        [protocolId]: { revision: listed.revision },
      }));
      return;
    }
    const revealed = await api.control.executeClientToken({
      command: "reveal",
      protocolId,
    });
    setTokens((current) => ({
      ...current,
      [protocolId]:
        revealed.outcome === "ok" && revealed.token !== undefined
          ? { revision: revealed.revision, token: revealed.token }
          : {
              revision: revealed.revision,
              unavailable: true,
              error: revealed.error ?? "Client token could not be revealed.",
            },
    }));
  };

  useEffect(() => {
    let active = true;
    void Promise.all(
      PROTOCOLS.map(async ({ id }) => {
        try {
          const listed = await api.control.executeClientToken({
            command: "list",
            protocolId: id,
          });
          if (!active) return;
          if (listed.outcome !== "ok") {
            setTokens((current) => ({
              ...current,
              [id]: {
                revision: listed.revision,
                unavailable: true,
                error: listed.error ?? "Client token is unavailable.",
              },
            }));
            return;
          }
          const hasGlobal = listed.scopes?.some((scope) => scope.type === "global") ?? false;
          if (!hasGlobal) {
            setTokens((current) => ({ ...current, [id]: { revision: listed.revision } }));
            return;
          }
          const revealed = await api.control.executeClientToken({
            command: "reveal",
            protocolId: id,
          });
          if (!active) return;
          setTokens((current) => ({
            ...current,
            [id]:
              revealed.outcome === "ok" && revealed.token !== undefined
                ? { revision: revealed.revision, token: revealed.token }
                : {
                    revision: revealed.revision,
                    unavailable: true,
                    error: revealed.error ?? "Client token could not be revealed.",
                  },
          }));
        } catch {
          if (!active) return;
          setTokens((current) => ({
            ...current,
            [id]: {
              revision: 0,
              unavailable: true,
              error: "Client token is temporarily unavailable.",
            },
          }));
        }
      }),
    );
    return () => {
      active = false;
    };
  }, [api]);

  const createToken = async (protocolId: ProtocolId): Promise<void> => {
    setBusy(protocolId);
    try {
      await api.control.executeClientToken({
        command: "create",
        protocolId,
        scope: { type: "global" },
      });
      await load(protocolId);
    } finally {
      setBusy(undefined);
    }
  };

  const rotateToken = async (protocolId: ProtocolId): Promise<void> => {
    const current = tokens[protocolId];
    if (current === undefined || current.token === undefined) return;
    setBusy(protocolId);
    try {
      const rotated = await api.control.executeClientToken({
        command: "rotate",
        protocolId,
        expectedRevision: current.revision,
      });
      if (rotated.outcome === "conflict") {
        await load(protocolId);
        return;
      }
      if (rotated.outcome !== "ok") {
        setTokens((state) => ({
          ...state,
          [protocolId]: {
            ...current,
            error: rotated.error ?? "Client token could not be rotated.",
          },
        }));
        return;
      }
      await load(protocolId);
    } finally {
      setBusy(undefined);
    }
  };

  const copyToken = async (protocolId: ProtocolId): Promise<void> => {
    const token = tokens[protocolId]?.token;
    if (token === undefined) return;
    await api.platform.writeClipboardText(token);
    setCopied(protocolId);
    globalThis.setTimeout(() => {
      setCopied((current) => (current === protocolId ? undefined : current));
    }, 1600);
  };

  return (
    <section className="settings-section page-card client-access-settings">
      <div>
        <p className="eyebrow">CLIENT ACCESS</p>
        <h3>Client access tokens</h3>
        <p>
          Use the global token for the protocol your client calls. Treat these values as secrets.
        </p>
      </div>
      <div className="client-token-list">
        {PROTOCOLS.map(({ id, name }) => {
          const state = tokens[id];
          return (
            <div className="client-token-row" key={id}>
              <div className="client-token-copy">
                <strong>{name}</strong>
                <span>Global token</span>
                {state === undefined ? (
                  <code>Loading…</code>
                ) : state.token !== undefined ? (
                  <code title={`${name} global token`}>{state.token}</code>
                ) : (
                  <code>No global token</code>
                )}
                {state?.error === undefined ? null : (
                  <p className="error-text" role="alert">{state.error}</p>
                )}
              </div>
              <div className="button-row compact client-token-actions">
                {state?.token === undefined ? (
                  <button
                    type="button"
                    disabled={state === undefined || state.unavailable === true || busy !== undefined}
                    onClick={() => void createToken(id)}
                  >
                    {busy === id ? "Creating…" : "Create"}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy !== undefined}
                      onClick={() => void copyToken(id)}
                    >
                      {copied === id ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== undefined}
                      onClick={() => void rotateToken(id)}
                    >
                      {busy === id ? "Rotating…" : "Rotate"}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
