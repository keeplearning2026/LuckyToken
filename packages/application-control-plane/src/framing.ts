import type { PipeConnection } from "./pipe-transport.js";

export const maxControlPlaneFrameBytes = 1024 * 1024;

export type ReadFrameResult =
  | { readonly type: "frame"; readonly value: unknown }
  | { readonly type: "end" }
  | { readonly type: "malformed" }
  | { readonly type: "oversized" };

async function readExact(
  connection: PipeConnection,
  byteLength: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let received = 0;
  while (received < byteLength) {
    const chunk = await connection.read(byteLength - received);
    if (chunk === null) return null;
    if (chunk.length === 0 || chunk.length > byteLength - received) {
      throw new Error("Pipe connection violated its bounded read contract");
    }
    chunks.push(chunk);
    received += chunk.length;
  }
  return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
}

export async function readFrame(
  connection: PipeConnection,
): Promise<ReadFrameResult> {
  const header = await readExact(connection, 4);
  if (header === null) return { type: "end" };
  const byteLength = header.readUInt32BE(0);
  if (byteLength > maxControlPlaneFrameBytes) return { type: "oversized" };
  const body = await readExact(connection, byteLength);
  if (body === null) return { type: "malformed" };
  try {
    return { type: "frame", value: JSON.parse(body.toString("utf8")) };
  } catch {
    return { type: "malformed" };
  }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > maxControlPlaneFrameBytes) {
    throw new Error("Control Plane frame exceeds the maximum size");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export async function writeFrame(
  connection: PipeConnection,
  value: unknown,
): Promise<void> {
  await connection.write(encodeFrame(value));
}
