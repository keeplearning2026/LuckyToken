import type { DiagnosticsWorkerSession } from "../../src/diagnostics/authority.js";

export class StalledDiagnosticsSession implements DiagnosticsWorkerSession {
  readonly posted: object[] = [];
  #listener: ((message: unknown) => void) | undefined;

  postMessage(message: object): boolean {
    this.posted.push(message);
    return true;
  }

  onMessage(listener: (message: unknown) => void): void {
    this.#listener = listener;
    queueMicrotask(() => listener({ type: "ready" }));
  }

  onError(): void {}
  onExit(): void {}
  async terminate(): Promise<number> { return 0; }

  release(): void {
    for (const raw of this.posted.splice(0)) {
      const message = raw as {
        readonly type?: string;
        readonly runtimeId?: string;
        readonly requestId?: string;
        readonly recordId?: string;
        readonly sequence?: number;
        readonly artifactId?: string;
        readonly chunkIndex?: number;
        readonly commandId?: number;
      };
      if (message.type === "append") {
        this.#listener?.({
          type: "ack",
          runtimeId: message.runtimeId,
          requestId: message.requestId,
          recordId: message.recordId,
          sequence: message.sequence,
        });
      } else if (message.type?.startsWith("artifact_")) {
        this.#listener?.({
          type: "ack",
          runtimeId: message.runtimeId,
          requestId: message.requestId,
          artifactId: message.artifactId,
          chunkIndex: message.chunkIndex,
        });
      } else if (message.commandId !== undefined) {
        this.#listener?.({ type: "closed", commandId: message.commandId });
      }
    }
  }
}
