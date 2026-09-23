import { createInterface } from "node:readline";

const serverInfo = Object.freeze({
  name: "token-schema-probe",
  version: "1.0.0",
});

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

const tool = Object.freeze({
  name: "schema_model_probe",
  description:
    "Test-only tool whose input schema intentionally contains a property named model.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      model: Object.freeze({
        type: "string",
        description: "Requested model",
      }),
    }),
    additionalProperties: false,
  }),
});

const input = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null) return;

  const id = message.id;
  const method = message.method;
  if (typeof method !== "string") return;

  if (method === "initialize") {
    const requested =
      message.params &&
      typeof message.params === "object" &&
      typeof message.params.protocolVersion === "string"
        ? message.params.protocolVersion
        : "2025-06-18";
    result(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo,
    });
    return;
  }
  if (method === "tools/list") {
    result(id, { tools: [tool] });
    return;
  }
  if (method === "tools/call") {
    result(id, {
      content: [{ type: "text", text: "SCHEMA_MODEL_PROBE_OK" }],
      isError: false,
    });
    return;
  }
  if (method === "ping") {
    result(id, {});
    return;
  }

  if (id !== undefined && id !== null) {
    error(id, -32601, `Method not found: ${method}`);
  }
});
