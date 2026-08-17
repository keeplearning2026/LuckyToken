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

export async function createProductionControlPipe(): Promise<ProductionControlPipe> {
  const nodeTransport = createNodePipeTransport();
  return Object.freeze({
    pipeServerFactory: nodeTransport,
    pipeConnector: nodeTransport,
    access: nodePipeFallbackAccess,
  });
}
