#!/usr/bin/env node
// Mechanically index every observed field difference in the frozen final report.
// Cause definitions and source evidence live in doc/ProtocolCompareCauses.md.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const reportPath = fileURLToPath(new URL("../../artifacts/protocol-compare/final/report.json", import.meta.url));
const documentPath = fileURLToPath(new URL("../../doc/ProtocolCompareCauses.md", import.meta.url));
const startMarker = "<!-- GENERATED-CAUSE-INDEX-START -->";
const endMarker = "<!-- GENERATED-CAUSE-INDEX-END -->";

function causeFor(caseId, difference) {
  const { group, path, token, opencodex } = difference;
  const p = path.replace(/\[\d+\]/g, "[*]");
  if (group === "request") {
    if (/\.providerRequests\[\*\]$/.test(p)) return "Q-ADMISSION";
    if (/\.body\.(stream|stream_options)$/.test(p)) return "Q-STREAM";
    if (/\.body\.messages\[\*\]/.test(p)) {
      if (/^image\.|^file\./.test(caseId)) return "Q-MEDIA";
      if (/^reasoning\.(history|after-call|nonreasoning-target)/.test(caseId)) return "Q-REASONING-HISTORY";
      if (/\.reasoning_content$|\.tool_calls$|\.tool_call_id$/.test(p)) return "Q-TOOL-HISTORY";
      if (/^(tools\.(history|parallel-history|result-)|roles\.tool-gap|validation\.unresolved-call|replay\.)/.test(caseId)) return "Q-TOOL-HISTORY";
      return "Q-MESSAGE";
    }
    if (/\.body\.tools/.test(p)) {
      if (/\.function\.strict$/.test(p)) return "Q-TOOL-SCHEMA";
      if (caseId.startsWith("tools.hosted")) return "Q-HOSTED";
      if (caseId.startsWith("controls.tool-choice-none")) return "Q-CHOICE";
      return "Q-TOOL-SCHEMA";
    }
    if (/\.body\.tool_choice$/.test(p)) return "Q-CHOICE";
    if (/\.body\.parallel_tool_calls$/.test(p)) return "Q-PARALLEL";
    if (/\.body\.reasoning_effort$/.test(p)) return "Q-REASONING";
    if (/\.body\.(prompt_cache_key|prompt_cache_retention)$/.test(p)) return "Q-CACHE";
    if (/\.body\.(top_p|stop|presence_penalty|frequency_penalty|response_format)$/.test(p)) return "Q-CONTROL";
  }
  if (group === "response") {
    if (/\.terminal\.output\[\*\]\.phase$/.test(p)) return "P-PHASE";
    if (/\.terminal\.output\[\*\]\.(summary|encrypted_content|token_continuity)/.test(p)) return "P-REASONING";
    if (/\.terminal\.output\[\*\]\.(arguments|status)$/.test(p)) return "P-TOOL";
    if (/\.terminal\.output/.test(p)) {
      if (caseId.startsWith("response.reasoning-text-field")) return "P-REASONING";
      if (caseId.startsWith("response.invalid-arguments")) return "P-TOOL";
      if (/^(response\.(filter|truncated-stream)|response\.http-)/.test(caseId)) return "P-TERMINAL";
      if (/^(tools\.custom|controls\.unconsumed-shape|validation\.(unknown-item|orphan-output|bad-arguments|bad-limit))/.test(caseId)) return "Q-ADMISSION";
    }
    if (/\.terminal\.usage$/.test(p)) return "P-USAGE";
    if (/\.terminal\.error/.test(p)) {
      if (p.endsWith(".terminal.error") && token.present && token.value === null && !opencodex.present) return "P-SHAPE";
      return "P-ERROR";
    }
    if (/\.terminal\.incomplete_details$/.test(p)) {
      if (token.present && token.value === null && !opencodex.present) return "P-SHAPE";
      return "P-TERMINAL";
    }
    if (/\.status$|\.terminal\.status$/.test(p)) return "P-TERMINAL";
  }
  if (group === "envelope") {
    if (/\.envelope\.model$/.test(p)) return "E-MODEL";
    if (/\.envelope\.previous_response_id$/.test(p)) return "E-CONTINUITY";
    if (/\.envelope\.(id|object|created_at|last_error)$/.test(p)) return "E-ERROR";
    if (/\.envelope\.(instructions|metadata|parallel_tool_calls|temperature|tool_choice|tools|top_p)$/.test(p)) return "E-DEFAULT";
  }
  if (group === "events") {
    if (/\.events\.framing/.test(p)) return "V-FRAMING";
    if (/\.events\.data\[0\]\.response\./.test(path)) return "V-SNAPSHOT";
    if (/\.events\.data/.test(p)) return "V-TOPOLOGY";
  }
  throw new Error(`Unclassified difference: ${caseId} ${group}: ${path}`);
}

function caseObservation(caseId, scenario) {
  const request = scenario.steps?.[0]?.request ?? {};
  const reply = scenario.steps?.[0]?.reply ?? {};
  const features = [];
  if (typeof request.input === "string") features.push("字符串输入");
  else if (Array.isArray(request.input)) features.push(`${request.input.length} 个输入 item`);
  if (request.instructions !== undefined) features.push("顶层 instructions");
  if (Array.isArray(request.tools)) features.push(`${request.tools.length} 个声明工具`);
  if (request.tool_choice !== undefined) features.push("tool_choice");
  if (request.reasoning !== undefined) features.push("reasoning");
  if (request.previous_response_id !== undefined) features.push("previous_response_id");
  if (reply.reasoning !== undefined || reply.reasoningText !== undefined) features.push("模拟 reasoning");
  if (reply.calls !== undefined) features.push("模拟工具调用");
  if (reply.finishReason !== undefined) features.push(`模拟 finishReason=${String(reply.finishReason)}`);
  if (scenario.steps?.length > 1) features.push(`${scenario.steps.length} 步回放`);
  const base = caseId.replace(/\.(json|sse)$/, "");
  const note = {
    "roles.mid-system": "system 入站被 opencodex 前置；Token 中途 Pi SystemMessage 在本夹具写成 Chat developer。",
    "roles.mid-developer": "developer 入站两方都可留在时间线；Token 已丢失 source role，opencodex 保留后按目的地选择 Chat role。",
    "roles.tool-gap-system": "同时包含 system 前置差异与未闭合工具交换中的 Pi 延迟/修复。",
    "roles.tool-gap-developer": "同时包含 developer role 边界与未闭合工具交换中的 Pi 延迟/修复。",
    "roles.unsupported-mid-system": "夹具明确禁用 mid-system；Token 把可降级中途指令变成 user，opencodex 仍先抽入 systemPrompt。",
    "tools.custom": "Token 不接受该 custom format.type=text；opencodex 可包装成函数并继续。",
    "tools.hosted": "opencodex 注入 tool_search 动态发现；Token 的普通 lookup/Pi 工具不是同一列表。",
    "controls.unconsumed-shape": "Token 未消费 top_p 形状；opencodex 入站 schema 校验该字段并拒绝。",
    "validation.unresolved-call": "Token 默认 xrepair 未解析工具调用；opencodex 使用自己的工具历史规则。",
    "response.filter": "先检查双方实际模拟上游格式；content_filter 在 Pi 与 opencodex 的终止映射不同。",
    "response.truncated-stream": "夹具按双方上游 stream 选不同模拟字节；不可当同字节解析器对比。",
    "response.invalid-arguments": "非法工具参数经过 Pi/Token 与 opencodex 各自验证/修复；夹具上游格式也可能不同。",
    "replay.previous.store-false": "第二步继续状态分别从各自首轮结果/本地状态构造；重点看 previous_response_id 是否可用。",
  }[base];
  return [note, features.join("；")].filter(Boolean).join(" ");
}

const report = JSON.parse(await readFile(reportPath, "utf8"));
const doc = await readFile(documentPath, "utf8");
const start = doc.indexOf(startMarker);
const end = doc.indexOf(endMarker);
if (start < 0 || end < 0 || end < start) throw new Error("Missing generated-index markers");
const out = [];
const totals = new Map();
let diffCount = 0;
for (const entry of report.cases) {
  const scenario = JSON.parse(await readFile(fileURLToPath(new URL(`../../artifacts/protocol-compare/final/cases/${entry.id}/scenario.json`, import.meta.url)), "utf8"));
  const rows = entry.differences.map(d => ({ difference: d, cause: causeFor(entry.id, d) }));
  const local = new Map();
  for (const row of rows) {
    diffCount++;
    totals.set(row.cause, (totals.get(row.cause) ?? 0) + 1);
    local.set(row.cause, (local.get(row.cause) ?? 0) + 1);
  }
  const counts = [...local].sort((a, b) => a[0].localeCompare(b[0])).map(([cause, n]) => `\`${cause}\`×${n}`).join("，");
  out.push(`### ${entry.id}`);
  out.push("");
  out.push(`[原始差异](../artifacts/protocol-compare/final/cases/${entry.id}/diff.md) · [输入与模拟回复](../artifacts/protocol-compare/final/cases/${entry.id}/scenario.json) · ${rows.length} 项；${counts}。`);
  const observation = caseObservation(entry.id, scenario);
  if (observation) out.push("", `场景提示：${observation}`);
  out.push("", "<details><summary>逐字段路径与归因</summary>", "", "| 分组与报告路径 | 根因 |", "|---|---|");
  for (const { difference, cause } of rows) {
    out.push(`| ${difference.group} · \`${difference.path.replace(/\|/g, "\\|")}\` | \`${cause}\` |`);
  }
  out.push("", "</details>", "");
}
if (report.cases.length !== report.summary.cases || diffCount !== report.summary.differences) {
  throw new Error(`Report tally mismatch: ${report.cases.length}/${diffCount}`);
}
const intro = [
  `覆盖校验：**${report.cases.length} / ${report.summary.cases} 个场景，${diffCount} / ${report.summary.differences} 个差异，未分类 0**。`,
  "",
  `归因计数：${[...totals].sort((a, b) => a[0].localeCompare(b[0])).map(([id, n]) => `\`${id}\` ${n}`).join("；")}。`,
  "",
];
const replacement = `${startMarker}\n${[...intro, ...out].join("\n")}\n${endMarker}`;
const updated = doc.slice(0, start) + replacement + doc.slice(end + endMarker.length);
await writeFile(documentPath, updated, "utf8");
console.log(`Indexed ${report.cases.length} cases and ${diffCount} differences in ${documentPath}`);
