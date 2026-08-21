export const fixtureValue = (): Promise<unknown> =>
  // @ts-expect-error This nonexistent package is the forbidden fixture edge.
  import("@forbidden/target");
