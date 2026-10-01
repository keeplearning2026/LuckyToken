import type { ReactElement } from "react";

import { providerIconDefinitions } from "./provider-icons.js";

/** First visible letter or number of the Provider identity. */
export function providerIconMonogram(
  providerId: string,
  name: string,
): string {
  for (const candidate of [name, providerId]) {
    const match = /[\p{L}\p{N}]/u.exec(candidate);
    if (match !== null) return match[0].toLocaleUpperCase();
  }
  return "?";
}

export interface ProviderIconProps {
  readonly providerId: string;
  readonly name: string;
}

/**
 * Provider card brand mark. Known Providers render the vendored monotone
 * brand glyph; user Provider Packages and future Pi built-ins without a
 * glyph render a monogram tile of the same size, so the card layout and the
 * title row height never depend on icon coverage.
 *
 * The mark is decorative: the adjacent Provider name already carries the
 * identity for assistive technology.
 */
export function ProviderIcon({
  providerId,
  name,
}: ProviderIconProps): ReactElement {
  const definition = providerIconDefinitions[providerId];
  if (definition === undefined) {
    return (
      <span
        className="provider-icon monogram"
        aria-hidden="true"
        data-provider-icon="fallback"
      >
        {providerIconMonogram(providerId, name)}
      </span>
    );
  }
  return (
    <span
      className="provider-icon"
      aria-hidden="true"
      data-provider-icon={providerId}
    >
      <svg viewBox="0 0 24 24" focusable="false">
        {definition.paths.map((path) => (
          <path
            key={path.d}
            d={path.d}
            fill="currentColor"
            fillRule={path.fillRule}
            clipRule={path.clipRule}
          />
        ))}
      </svg>
    </span>
  );
}
