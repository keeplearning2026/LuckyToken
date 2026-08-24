const STATUS_TEXT_PRESERVATION = new WeakSet<Response>();

export function preserveDirectStatusText(response: Response): Response {
  STATUS_TEXT_PRESERVATION.add(response);
  return response;
}

export function copyDirectResponseMetadata(
  source: Response,
  target: Response,
): Response {
  if (STATUS_TEXT_PRESERVATION.has(source)) {
    STATUS_TEXT_PRESERVATION.add(target);
  }
  return target;
}

export function preservesDirectStatusText(response: Response): boolean {
  return STATUS_TEXT_PRESERVATION.has(response);
}
