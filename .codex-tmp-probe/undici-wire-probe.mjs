import { createServer } from "node:http";

const received = [];
const server = createServer((req, res) => {
  received.push(req.headers);
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/v1/responses`;

// Mirrors Token's provider-native openai sender header set.
await fetch(url, {
  method: "POST",
  headers: new Headers({
    accept: "application/json",
    authorization: "Bearer sk-test",
    "content-type": "application/json",
  }),
  body: JSON.stringify({ model: "gpt-5", input: "hi" }),
});

// Mirrors Pi's OpenAI-SDK header set (SDK headers included).
await fetch(url, {
  method: "POST",
  headers: new Headers({
    accept: "application/json",
    authorization: "Bearer sk-test",
    "content-type": "application/json",
    "user-agent": "pi (win32 10.0.26200; x64)",
    "x-stainless-lang": "js",
  }),
  body: JSON.stringify({ model: "gpt-5", input: "hi" }),
});

server.close();

for (const [index, headers] of received.entries()) {
  console.log(`\n=== request ${index + 1} as received by an HTTP server ===`);
  for (const [name, value] of Object.entries(headers).sort()) {
    console.log(`${name}: ${value}`);
  }
}
