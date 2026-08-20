export interface ServerConfig {
  workingDir: string;
  date: string;
  environment: string;
  structure: string[];
  isGitRepo: boolean;
  currentBranch: string;
  mainBranch: string;
  gitStatus: string;
  recentCommits: string[];
}

/**
 * CommandCode Private no longer derives project/workspace state from Pi
 * metadata. The Provider always sends the fixed empty server config required
 * by the upstream wire contract.
 */
export function createEmptyServerConfig(): ServerConfig {
  return {
    workingDir: "",
    date: "",
    environment: "",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}
