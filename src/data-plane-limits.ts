/** Default loopback data-plane request admission ceiling. The raw transport
 * body and its decoded representation are both bounded by this value. */
export const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024 * 1024;

/** Default total lifetime for an admitted Data Plane request. Long-running
 * model responses, including Direct Mode response streams, may legitimately
 * remain active well beyond two minutes. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
