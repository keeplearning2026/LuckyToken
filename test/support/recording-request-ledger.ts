import type { RequestLedger } from "../../src/request-ledger/index.js";
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";

export function createRecordingRequestLedger() {
  const terminalUsage: NormalizedTerminalUsage[] = [];
  const models: Array<{
    externalAlias: string;
    providerId: string;
    realModelId: string;
  }> = [];
  const ledger = {
    begin: () => ({
      requestId: "90000000-0000-4000-8000-000000000001",
      authorized: () => undefined,
      aliasCaptured: () => undefined,
      modelResolved: (snapshot: {
        externalAlias: string;
        providerId: string;
        realModelId: string;
      }) => models.push(snapshot),
      executing: () => undefined,
      rendering: () => undefined,
      terminal: () => undefined,
      terminalUsage: (snapshot: NormalizedTerminalUsage) => terminalUsage.push(snapshot),
      notice: () => undefined,
      attempt: () => undefined,
      fail: () => undefined,
      completed: () => undefined,
    }),
    query: () => ({ records: [], total: 0, limit: 0, offset: 0 }),
    subscribe: () => ({ unsubscribe: () => undefined }),
  } as unknown as RequestLedger;
  return { ledger, terminalUsage, models };
}
