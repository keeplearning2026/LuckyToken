import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { ClientProtocolRequestContext } from "./http.js";

export interface WebSocketUpgradeInput {
  readonly request: IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
  readonly url: URL;
  readonly context: ClientProtocolRequestContext;
}

/** Optional transport seam for one installed WebSocket-capable Client wire.
 * The handler owns every matched socket from authentication through close. */
export interface WebSocketUpgradeHandler {
  matches(request: IncomingMessage, url: URL): boolean;
  handleUpgrade(input: WebSocketUpgradeInput): Promise<void>;
  closeAll(): void;
  terminateAll(): void;
}
