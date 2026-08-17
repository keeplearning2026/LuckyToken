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
  _facts: ControlPipeHostFacts = {
    platform: process.platform,
    architecture: process.arch,
  },
): Promise<ProductionControlPipe> {
  const nodeTransport = createNodePipeTransport();
  return Object.freeze({
    pipeServerFactory: nodeTransport,
    pipeConnector: nodeTransport,
    access: nodePipeFallbackAccess,
  });
}
