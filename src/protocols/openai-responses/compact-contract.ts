export interface LocalResponsesCompactLane {
  claims(selector: string): boolean;
  execute(input: {
    readonly request: Request;
    readonly rawBody: string;
    readonly selector: string;
  }): Promise<Response>;
}
