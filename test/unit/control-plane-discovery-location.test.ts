import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveControlPlaneDescriptorPath } from "../../src/control-plane-discovery.js";

describe("native Control Plane descriptor discovery", () => {
  it("uses one current-user authority independent of the selected config", () => {
    expect(
      resolveControlPlaneDescriptorPath({
        homeDirectory: "C:\\Users\\Alice",
      }),
    ).toBe(join("C:\\Users\\Alice", ".Token", "control-plane.json"));
  });

  it("allows an explicit native/CLI override without reading descriptor data", () => {
    expect(
      resolveControlPlaneDescriptorPath({
        homeDirectory: "C:\\Users\\Alice",
        overridePath: "D:\\test-state\\control-plane.json",
      }),
    ).toBe("D:\\test-state\\control-plane.json");
  });
});
