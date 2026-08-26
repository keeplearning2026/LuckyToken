const DIRECT_RESPONSE = new WeakSet<Response>();
const STATUS_TEXT_PRESERVATION = new WeakSet<Response>();

export function preserveDirectResponse(response: Response): Response {
  DIRECT_RESPONSE.add(response);
  return response;
}

export function preserveDirectStatusText(response: Response): Response {
  DIRECT_RESPONSE.add(response);
  STATUS_TEXT_PRESERVATION.add(response);
  return response;
}

export function copyDirectResponseMetadata(
  source: Response,
  target: Response,
): Response {
  if (DIRECT_RESPONSE.has(source)) DIRECT_RESPONSE.add(target);
  if (STATUS_TEXT_PRESERVATION.has(source)) STATUS_TEXT_PRESERVATION.add(target);
  return target;
}

export function preservesDirectResponse(response: Response): boolean {
  return DIRECT_RESPONSE.has(response);
}

export function preservesDirectStatusText(response: Response): boolean {
  return STATUS_TEXT_PRESERVATION.has(response);
}
