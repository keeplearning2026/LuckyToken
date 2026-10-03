import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const LICENSE = `MIT License\nCopyright (c) 2025 Mario Zechner\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.`;
const PI = "@earendil-works/pi-ai";
const ua = `import { getPiUserAgent } from "${PI}/utils/pi-user-agent";`;
const env = `import { getProviderEnvValue } from "${PI}/utils/provider-env";`;

// Only request-envelope code is selected. Body conversion, Pi IR, response
// parsing, Provider execution and retries are never copied into Native.
const recipes = [
  {
    api: "openai-responses", target: "provider-native-responses/pi-openai.generated.ts",
    names: ["detectSessionAffinityFormat", "getCompat", "createClient"],
    imports: `import OpenAI from "openai";\n${ua}`,
    signatures: { createClient: 6 }, exports: ["createClient"],
    patch(declarations) {
      const node = declarations.get("createClient");
      const branch = node.body.statements.filter((statement) => ts.isIfStatement(statement) && statement.expression.getText().includes('model.provider === "github-copilot"'));
      if (branch.length !== 1 || !branch[0].getText().includes("context.messages")) throw new Error("OpenAI Copilot envelope extraction point changed");
      return new Map([["createClient", replaceNode(node.getText(), node, branch[0], "if (model.provider === \"github-copilot\") Object.assign(headers, dynamicHeaders);").replace("model, context, apiKey", "model, dynamicHeaders, apiKey")]]);
    },
    changes: "Copilot Context reads replaced with Native-owned dynamicHeaders input.",
  },
  {
    api: "azure-openai-responses", target: "provider-native-responses/pi-azure.generated.ts",
    names: ["DEFAULT_AZURE_API_VERSION", "parseDeploymentNameMap", "resolveDeploymentName", "normalizeAzureBaseUrl", "buildDefaultBaseUrl", "resolveAzureConfig", "createClient"],
    imports: `import { AzureOpenAI } from "openai";\n${ua}\n${env}`,
    signatures: { createClient: 3, resolveAzureConfig: 2, resolveDeploymentName: 2 },
    exports: ["createClient", "resolveAzureConfig", "resolveDeploymentName"], changes: "No implementation changes.",
  },
  {
    api: "openai-codex-responses", target: "provider-native-responses/pi-codex.generated.ts",
    names: ["DEFAULT_CODEX_BASE_URL", "REQUEST_COMPRESSION_ZSTD_LEVEL", "loadNodeZlib", "compressRequestBodyZstd", "resolveCodexUrl", "buildBaseCodexHeaders", "buildSSEHeaders"],
    imports: ua,
    signatures: { buildBaseCodexHeaders: 4, buildSSEHeaders: 5, resolveCodexUrl: 1, compressRequestBodyZstd: 1 },
    exports: ["buildBaseCodexHeaders", "buildSSEHeaders", "resolveCodexUrl", "compressRequestBodyZstd"], changes: "No implementation changes.",
  },
  {
    api: "anthropic-messages", target: "provider-native-anthropic/pi-envelope.generated.ts",
    names: ["claudeCodeVersion", "FINE_GRAINED_TOOL_STREAMING_BETA", "INTERLEAVED_THINKING_BETA", "SERVER_SIDE_FALLBACK_BETA", "MID_CONVERSATION_OUTPUT_CONFIG_BETA", "THINKING_BINDING_CONTROLS_BETA", "MID_CONVERSATION_TOOL_CHANGES_BETA", "shouldUseServerSideFallbackBeta", "getAnthropicCompat", "mergeHeaders", "mergeClientHeaders", "PiAnthropic", "isOAuthToken", "createClient", "getBetaFeatures", "shouldUseFineGrainedToolStreamingBeta"],
    imports: `import Anthropic from "@anthropic-ai/sdk";\n${ua}`,
    signatures: { createClient: 7, getBetaFeatures: 5, shouldUseFineGrainedToolStreamingBeta: 2 },
    exports: ["createClient", "getBetaFeatures", "getAnthropicCompat", "claudeCodeVersion"],
    patch(declarations) {
      const node = declarations.get("createClient");
      const federation = node.body.statements.filter((statement) => ts.isIfStatement(statement) && statement.expression.getText() === "federation");
      if (federation.length !== 1) throw new Error("Anthropic federation extraction point changed");
      const fine = declarations.get("shouldUseFineGrainedToolStreamingBeta").getText();
      if (!fine.includes("getCurrentTools(context.messages).length > 0")) throw new Error("Anthropic tools extraction point changed");
      return new Map([
        ["createClient", replaceNode(node.getText(), node, federation[0], "").replace("sessionId, federation)", "sessionId)")],
        ["getBetaFeatures", declarations.get("getBetaFeatures").getText().replaceAll("context", "hasTools")],
        ["shouldUseFineGrainedToolStreamingBeta", fine.replace("model, context)", "model, hasTools)").replace("getCurrentTools(context.messages).length > 0", "hasTools")],
      ]);
    },
    changes: "Tools Context read replaced with boolean hasTools; federation branch omitted (not a certified Native credential path).",
  },
];

function replaceNode(text, parent, child, replacement) {
  const offset = parent.getStart();
  return text.slice(0, child.getStart() - offset) + replacement + text.slice(child.end - offset);
}

export async function renderPiNative(root, overrides = {}) {
  const pi = JSON.parse(await readFile(resolve(root, "node_modules", PI, "package.json"), "utf8"));
  if (pi.license !== "MIT") throw new Error("Pi license changed; review vendoring permission");
  const rendered = new Map();
  for (const recipe of recipes) {
    const upstreamPath = `node_modules/${PI}/dist/api/${recipe.api}.js`;
    const source = overrides[recipe.api] ?? await readFile(resolve(root, upstreamPath), "utf8");
    const ast = ts.createSourceFile(upstreamPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declarations = new Map();
    for (const statement of ast.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declarations.set(statement.name.text, statement);
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
      }
    }
    for (const name of recipe.names) if (!declarations.has(name)) throw new Error(`${recipe.api}: missing ${name}; review upstream extraction`);
    for (const [name, count] of Object.entries(recipe.signatures)) {
      if (declarations.get(name).parameters?.length !== count) throw new Error(`${recipe.api}: ${name} signature changed`);
    }
    const patched = recipe.patch?.(declarations) ?? new Map();
    const copied = recipe.names.map((name) => patched.get(name) ?? declarations.get(name).getText()).join("\n\n");
    if (/\b(context|TranscriptContext|normalizeContext|resolveTranscript|processResponsesStream)\b/u.test(copied)) throw new Error(`${recipe.api}: semantic dependency escaped into Native`);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    rendered.set(resolve(root, "src", recipe.target), `// @ts-nocheck -- generated upstream JavaScript; signatures, dependencies and wire parity are certified.\n/* eslint-disable */\n// Generated by npm run pi:upgrade. Do not edit.\n// Pi ${pi.version}; source: ${upstreamPath}; SHA256: ${sourceHash}\n// Local modifications: ${recipe.changes}\n/*\n${LICENSE}\n*/\n${recipe.imports}\n\n${copied}\n\nexport { ${recipe.exports.join(", ")} };\n`);
  }
  // Check free names even though copied JS is excluded from TS style checking.
  // New private dependencies must fail before any generated file is written.
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...args) => rendered.has(resolve(path))
    ? ts.createSourceFile(path, rendered.get(resolve(path)).replace("// @ts-nocheck", "// upstream"), languageVersion, true)
    : original(path, languageVersion, ...args);
  const program = ts.createProgram([...rendered.keys()], { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] }, host);
  const errors = program.getSemanticDiagnostics().filter((diagnostic) => [2304, 2552, 2307, 18004].includes(diagnostic.code));
  if (errors.length) throw new Error(`Pi Native dependencies changed: ${errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ")}`);
  return rendered;
}

export async function synchronizePiNative(root, check = false) {
  const rendered = await renderPiNative(root);
  if (check) {
    for (const [path, source] of rendered) if ((await readFile(path, "utf8")).replaceAll("\r\n", "\n") !== source) throw new Error(`Pi Native copy differs: ${path}; run npm run pi:upgrade`);
  } else {
    for (const [path, source] of rendered) await writeFile(path, source);
  }
}
