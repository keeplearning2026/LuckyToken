import { useEffect, useState } from "react";

import type { LuckyTokenDesktopApi } from "../../shared/desktop-api.js";

const ACTIVE_PAGE_SIZE = 1_000;

export function useActiveRequests(
  api: LuckyTokenDesktopApi,
  backendAvailable: boolean,
): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!backendAvailable) {
      setCount(0);
      return;
    }
    let active = true;
    let initialized = false;
    const running = new Set<string>();
    const observedBeforeInitial = new Map<string, boolean>();

    const publish = (): void => {
      if (active) setCount(running.size);
    };

    const unsubscribe = api.control.onRequestLedger(({ record }) => {
      if (!active) return;
      const isRunning = record.outcome === "running";
      if (!initialized) observedBeforeInitial.set(record.requestId, isRunning);
      if (isRunning) running.add(record.requestId);
      else running.delete(record.requestId);
      publish();
    });

    void (async () => {
      const initial = new Set<string>();
      let afterId: number | undefined;
      for (;;) {
        const result = await api.control.getRequestLedger({
          outcome: "running",
          limit: ACTIVE_PAGE_SIZE,
          ...(afterId === undefined ? {} : { afterId }),
        });
        for (const record of result.records) {
          if (record.outcome === "running") initial.add(record.requestId);
        }
        const oldest = result.records.at(-1)?.id;
        if (!result.hasMore || oldest === undefined) break;
        afterId = oldest;
      }
      if (!active) return;
      running.clear();
      for (const requestId of initial) running.add(requestId);
      for (const [requestId, isRunning] of observedBeforeInitial) {
        if (isRunning) running.add(requestId);
        else running.delete(requestId);
      }
      observedBeforeInitial.clear();
      initialized = true;
      publish();
    })().catch(() => {
      if (!active) return;
      initialized = true;
      observedBeforeInitial.clear();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, backendAvailable]);

  return count;
}
