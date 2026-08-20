import { describe, expect, it } from "vitest";

import * as projectModule from "../../packages/provider-commandcode-private/src/project.js";
import { createEmptyServerConfig } from "../../packages/provider-commandcode-private/src/project.js";

describe("CommandCode fixed server config", () => {
  it("exposes no projectDir/filesystem/git snapshot capability", () => {
    expect(projectModule).not.toHaveProperty("classifyProjectDir");
    expect(projectModule).not.toHaveProperty("createProjectSnapshot");
    expect(projectModule).not.toHaveProperty("createNodeProjectSnapshot");
  });

  it("returns the fixed project-free CommandCode server config", () => {
    expect(createEmptyServerConfig()).toEqual({
      workingDir: "",
      date: "",
      environment: "",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    });
  });
});
