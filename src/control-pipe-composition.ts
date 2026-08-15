import {
  createNodePipeTransport,
  nodePipeFallbackAccess,
  type PipeAccessRequirement,
  type PipeConnector,
  type PipeServerFactory,
} from "@luckytoken/application-control-plane/control-plane";

export interface ProductionControlPipe {
  readonly pipeServerFactory: PipeServerFactory;
  readonly pipeConnector: PipeConnector;
  readonly access: PipeAccessRequirement;
}

export interface ControlPipeHostFacts {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
}

export class UnsupportedControlPipeArchitectureError extends Error {
  readonly code = "UNSUPPORTED_CONTROL_PIPE_ARCHITECTURE";
  readonly architecture: NodeJS.Architecture;

  constructor(architecture: NodeJS.Architecture) {
    super(`Windows Control Pipe does not support architecture ${architecture}`);
    this.name = "UnsupportedControlPipeArchitectureError";
    this.architecture = architecture;
  }
}

export async function createProductionControlPipe(
  facts: ControlPipeHostFacts = {
    platform: process.platform,
    architecture: process.arch,
  },
): Promise<ProductionControlPipe> {
  const nodeTransport = createNodePipeTransport();
  if (facts.platform === "win32") {
    if (facts.architecture !== "x64") {
      throw new UnsupportedControlPipeArchitectureError(facts.architecture);
    }
    const { createWindowsControlPipeHost } = await import(
      "./windows-control-pipe.js"
    );
    const windowsHost = createWindowsControlPipeHost();
    return Object.freeze({
      pipeServerFactory: windowsHost.pipeServerFactory,
      pipeConnector: nodeTransport,
      access: windowsHost.access,
    });
  }
  return Object.freeze({
    pipeServerFactory: nodeTransport,
    pipeConnector: nodeTransport,
    access: nodePipeFallbackAccess,
  });
}
