import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const LICENSE = `MIT License\nCopyright (c) 2025 Mario Zechner\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.`;
const PI = "@earendil-works/pi-ai";
const ua = `import { getPiUserAgent } from "${PI}/utils/pi-user-agent";`;
const env = `import { getProviderEnvValue } from "${PI}/utils/provider-env";`;

// These are the upstream regions whose implementation is discarded by a local
// patch. Compare their complete syntax, not merely a marker inside the region.
// Unmodified envelope code remains free to change and is copied automatically.
const copilotBranch = `if (model.provider === "github-copilot") {
  const hasImages = hasCopilotVisionInput(context.messages);
  const copilotHeaders = buildCopilotDynamicHeaders({ messages: context.messages, hasImages });
  Object.assign(headers, copilotHeaders);
}`;
const federationBranch = `if (federation) {
  const key = JSON.stringify([model.baseUrl, federation]);
  if (federationClient?.key !== key || federationClient.fetch !== fetch) {
    const client = new PiAnthropic({
      apiKey: null, authToken: null, config: federation, baseURL: model.baseUrl,
      dangerouslyAllowBrowser: true, fetch,
    });
    federationClient = { key, fetch, client };
  }
  return { client: federationClient.client.withOptions({ defaultHeaders }), isOAuthToken: false };
}`;
const fineGrainedTools = `function shouldUseFineGrainedToolStreamingBeta(model, context) {
  return getCurrentTools(context.messages).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}`;

// Only request-envelope code is selected. Body conversion, Pi IR, response
// parsing, Provider execution and retries are never copied into Native.
const recipes = [
  {
    api: "openai-responses", target: "provider-native-responses/pi-openai.generated.ts",
    names: ["hasHeader", "getClientApiKey", "detectSessionAffinityFormat", "getCompat", "createClient"],
    imports: `import OpenAI from "openai";\n${ua}`,
    signatures: { createClient: ["model", "context", "apiKey", "optionsHeaders", "fetch", "sessionId"], getClientApiKey: ["provider", "apiKey", "headers"] }, exports: ["createClient", "getClientApiKey"],
    patch(declarations) {
      const node = declarations.get("createClient");
      assertFreshInput(node, "dynamicHeaders", "OpenAI Copilot");
      const branch = node.body.statements.filter((statement) => ts.isIfStatement(statement) && descendants(statement.expression).some((child) => ts.isStringLiteral(child) && child.text === "github-copilot"));
      if (branch.length !== 1) throw new Error("OpenAI Copilot envelope extraction point changed");
      assertPatchStructure(branch[0], copilotBranch, "OpenAI Copilot branch");
      return new Map([["createClient", replaceNodes(node, [
        [branch[0], 'if (model.provider === "github-copilot") Object.assign(headers, dynamicHeaders);'],
        [node.parameters[1].name, "dynamicHeaders"],
      ])]]);
    },
    changes: "Copilot Context reads replaced with Native-owned dynamicHeaders input.",
  },
  {
    api: "azure-openai-responses", target: "provider-native-responses/pi-azure.generated.ts",
    names: ["DEFAULT_AZURE_API_VERSION", "parseDeploymentNameMap", "resolveDeploymentName", "normalizeAzureBaseUrl", "buildDefaultBaseUrl", "resolveAzureConfig", "createClient"],
    imports: `import { AzureOpenAI } from "openai";\n${ua}\n${env}`,
    signatures: { createClient: ["model", "apiKey", "options"], resolveAzureConfig: ["model", "options"], resolveDeploymentName: ["model", "options"] },
    exports: ["createClient", "resolveDeploymentName"], changes: "No implementation changes.",
  },
  {
    api: "openai-codex-responses", target: "provider-native-responses/pi-codex.generated.ts",
    names: ["DEFAULT_CODEX_BASE_URL", "REQUEST_COMPRESSION_ZSTD_LEVEL", "loadNodeZlib", "compressRequestBodyZstd", "resolveCodexUrl", "buildBaseCodexHeaders", "buildSSEHeaders"],
    imports: ua,
    signatures: { buildBaseCodexHeaders: ["initHeaders", "additionalHeaders", "accountId", "token"], buildSSEHeaders: ["initHeaders", "additionalHeaders", "accountId", "token", "sessionId"], resolveCodexUrl: ["baseUrl"], compressRequestBodyZstd: ["bodyJson"] },
    exports: ["buildBaseCodexHeaders", "buildSSEHeaders", "resolveCodexUrl", "compressRequestBodyZstd"], changes: "No implementation changes.",
  },
  {
    api: "anthropic-messages", target: "provider-native-anthropic/pi-envelope.generated.ts",
    names: ["claudeCodeVersion", "FINE_GRAINED_TOOL_STREAMING_BETA", "INTERLEAVED_THINKING_BETA", "SERVER_SIDE_FALLBACK_BETA", "MID_CONVERSATION_OUTPUT_CONFIG_BETA", "THINKING_BINDING_CONTROLS_BETA", "MID_CONVERSATION_TOOL_CHANGES_BETA", "shouldUseServerSideFallbackBeta", "getAnthropicCompat", "mergeHeaders", "mergeClientHeaders", "PiAnthropic", "createClient", "getBetaFeatures", "shouldUseFineGrainedToolStreamingBeta"],
    imports: `import Anthropic from "@anthropic-ai/sdk";\n${ua}`,
    signatures: { createClient: ["model", "apiKey", "optionsHeaders", "fetch", "dynamicHeaders", "sessionId", "federation"], getBetaFeatures: ["model", "context", "isOAuthToken", "nativeToolChanges", "options"], shouldUseFineGrainedToolStreamingBeta: ["model", "context"] },
    exports: ["createClient", "getBetaFeatures", "getAnthropicCompat", "claudeCodeVersion"],
    patch(declarations) {
      const node = declarations.get("createClient");
      assertFreshInput(node, "isOAuthCredential", "Anthropic OAuth");
      const federation = node.body.statements.filter((statement) => ts.isIfStatement(statement) && statement.expression.getText() === "federation");
      if (federation.length !== 1) throw new Error("Anthropic federation extraction point changed");
      assertPatchStructure(federation[0], federationBranch, "Anthropic federation branch");
      const oauth = node.body.statements.filter((statement) => ts.isIfStatement(statement) && descendants(statement.expression).some((child) => ts.isIdentifier(child) && child.text === "isOAuthToken"));
      if (oauth.length !== 1) throw new Error("Anthropic OAuth extraction point changed");
      assertPatchStructure(oauth[0].expression, "apiKey && isOAuthToken(apiKey);", "Anthropic OAuth condition");
      const fine = declarations.get("shouldUseFineGrainedToolStreamingBeta");
      assertFreshInput(fine, "hasTools", "Anthropic tools");
      assertPatchStructure(fine, fineGrainedTools, "Anthropic tools predicate");
      const beta = declarations.get("getBetaFeatures");
      assertFreshInput(beta, "hasTools", "Anthropic beta tools");
      const toolsCalls = descendants(beta.body).filter((child) => ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "shouldUseFineGrainedToolStreamingBeta");
      if (toolsCalls.length !== 1) throw new Error("Anthropic beta tools extraction point changed");
      assertPatchStructure(toolsCalls[0], "shouldUseFineGrainedToolStreamingBeta(model, context);", "Anthropic beta tools call");
      const contextNames = descendants(beta).filter((child) => ts.isIdentifier(child) && child.text === "context");
      if (contextNames.length !== 2 || !contextNames.includes(beta.parameters[1].name) || !contextNames.includes(toolsCalls[0].arguments[1])) throw new Error("Anthropic beta Context reads changed");
      return new Map([
        ["createClient", replaceNodes(node, [[federation[0], ""], [node.parameters[6].name, "isOAuthCredential"], [oauth[0].expression, "isOAuthCredential"]])],
        ["getBetaFeatures", replaceNodes(beta, contextNames.map((name) => [name, "hasTools"]))],
        ["shouldUseFineGrainedToolStreamingBeta", replaceNodes(fine, [[fine.parameters[1].name, "hasTools"], [fine.body.statements[0].expression.left, "hasTools"]])],
      ]);
    },
    changes: "Tools Context read replaced with boolean hasTools; OAuth selected by resolved credential kind; federation branch omitted (not a certified Native credential path).",
  },
];

function descendants(node) {
  const result = [];
  function visit(child) {
    result.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return result;
}

function assertFreshInput(node, name, label) {
  if (descendants(node).some((child) => ts.isIdentifier(child) && child.text === name)) throw new Error(`${label} patch input ${name} conflicts with upstream`);
}

function assertPatchStructure(node, expected, label) {
  const fixture = ts.createSourceFile("patch-contract.js", expected, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statement = fixture.statements[0];
  const expectedNode = ts.isExpressionStatement(statement) ? statement.expression : statement;
  function syntax(value) {
    const children = [];
    ts.forEachChild(value, (child) => { children.push(syntax(child)); });
    const declarationKind = ts.isVariableDeclarationList(value)
      ? value.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)
      : null;
    return [value.kind, typeof value.text === "string" ? value.text : null, declarationKind, children];
  }
  if (JSON.stringify(syntax(node)) !== JSON.stringify(syntax(expectedNode))) throw new Error(`${label} patch structure changed; review upstream semantics`);
}

function replaceNodes(parent, replacements) {
  let text = parent.getText();
  const offset = parent.getStart();
  for (const [child, replacement] of replacements.sort(([a], [b]) => b.getStart() - a.getStart())) {
    text = text.slice(0, child.getStart() - offset) + replacement + text.slice(child.end - offset);
  }
  return text;
}

export async function renderPiNative(root, overrides = {}) {
  const pi = JSON.parse(await readFile(resolve(root, "node_modules", PI, "package.json"), "utf8"));
  if (pi.license !== "MIT") throw new Error("Pi license changed; review vendoring permission");
  const rendered = new Map();
  for (const recipe of recipes) {
    const upstreamPath = `node_modules/${PI}/dist/api/${recipe.api}.js`;
    const source = overrides[recipe.api] ?? await readFile(resolve(root, upstreamPath), "utf8");
    const ast = ts.createSourceFile(upstreamPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error(`${recipe.api}: upstream syntax changed or invalid`);
    const declarations = new Map();
    for (const statement of ast.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) declarations.set(statement.name.text, statement);
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
      }
    }
    for (const name of recipe.names) if (!declarations.has(name)) throw new Error(`${recipe.api}: missing ${name}; review upstream extraction`);
    for (const [name, parameters] of Object.entries(recipe.signatures)) {
      const declaration = declarations.get(name);
      const actual = declaration.parameters?.map((parameter) => parameter.name.getText());
      if (JSON.stringify(actual) !== JSON.stringify(parameters) || declaration.asteriskToken || declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || declaration.parameters.some((parameter) => parameter.initializer || parameter.dotDotDotToken)) throw new Error(`${recipe.api}: ${name} signature changed`);
    }
    const patched = recipe.patch?.(declarations) ?? new Map();
    const copied = recipe.names.map((name) => patched.get(name) ?? declarations.get(name).getText()).join("\n\n");
    if (/\b(context|TranscriptContext|normalizeContext|resolveTranscript|processResponsesStream)\b/u.test(copied)) throw new Error(`${recipe.api}: semantic dependency escaped into Native`);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    rendered.set(resolve(root, "src", recipe.target), `/* eslint-disable */\n// @ts-nocheck -- generated upstream JavaScript; signatures, dependencies and wire parity are certified.\n// Generated by npm run pi:upgrade. Do not edit.\n// Pi ${pi.version}; source: ${upstreamPath}; SHA256: ${sourceHash}\n// Local modifications: ${recipe.changes}\n/*\n${LICENSE}\n*/\n${recipe.imports}\n\n${copied}\n\nexport { ${recipe.exports.join(", ")} };\n`);
  }
  // Check free names even though copied JS is excluded from TS style checking.
  // New private dependencies must fail before any generated file is written.
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...args) => rendered.has(resolve(path))
    ? ts.createSourceFile(path, rendered.get(resolve(path)).replace("// @ts-nocheck", "// upstream"), languageVersion, true)
    : original(path, languageVersion, ...args);
  const program = ts.createProgram([...rendered.keys()], { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] }, host);
  if (program.getSyntacticDiagnostics().length) throw new Error("Pi Native generated syntax invalid");
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
