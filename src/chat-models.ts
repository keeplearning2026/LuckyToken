import type { Models } from "@earendil-works/pi-ai";

/** Pi's public operations consumed by Token's chat data plane and control plane.
 * New image/classifier operations do not expand this contract implicitly. */
export type ChatModels = Pick<
  Models,
  | "getProviders"
  | "getProvider"
  | "getModels"
  | "getModel"
  | "refresh"
  | "checkAuth"
  | "getAvailable"
  | "getAuth"
  | "login"
  | "logout"
  | "stream"
  | "complete"
  | "streamSimple"
  | "completeSimple"
  | "fetchDeferred"
  | "cancelDeferred"
>;
