import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function differences(left, right, path = "$", out = []) {
  if (Object.is(left, right)) return out;
  if (left && right && typeof left === "object" && typeof right === "object" && Array.isArray(left) === Array.isArray(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      differences(left[key], right[key], Array.isArray(left) ? `${path}[${key}]` : `${path}.${key}`, out);
    }
  } else out.push({ path,
    token: left === undefined ? { present: false } : { present: true, value: left },
    opencodex: right === undefined ? { present: false } : { present: true, value: right },
  });
  return out;
}

export function normalizeResponses(parsed) {
  const copy = structuredClone(parsed);
  const identities = new Map();
  let itemCount = 0;
  function response(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.id === "string") identities.set(value.id, "<response-id>");
    for (const item of value.output ?? []) {
      if (typeof item.id === "string" && !identities.has(item.id)) identities.set(item.id, `<item-${++itemCount}>`);
    }
    for (const field of ["created_at", "completed_at"]) if (field in value) value[field] = "<time>";
  }
  response(copy.json);
  for (const event of copy.events ?? []) {
    response(event.response);
    if (typeof event.item?.id === "string" && !identities.has(event.item.id)) identities.set(event.item.id, `<item-${++itemCount}>`);
  }
  // Only protocol identity locations are normalized. User text, tool arguments,
  // call_id, metadata, signatures, usage and roles retain their exact values.
  const identity = object => {
    if (!object) return;
    for (const key of ["id", "item_id", "response_id"]) if (identities.has(object[key])) object[key] = identities.get(object[key]);
  };
  const responseIds = value => { identity(value); for (const item of value?.output ?? []) identity(item); };
  responseIds(copy.json);
  for (const event of copy.events ?? []) { identity(event); identity(event.item); responseIds(event.response); }
  return copy;
}

export function comparisonView(result) {
  return (result.steps ?? []).map(step => {
    const parsed = step.response ? normalizeResponses(step.response.parsed) : undefined;
    const { output, status, usage, error, incomplete_details, ...envelope } = parsed?.json ?? {};
    return {
      providerRequests: (step.providerRequests ?? []).map(request => ({ method: request.method, url: request.url, body: request.body })),
      status: step.response?.status,
      terminal: parsed?.json === undefined ? undefined : { output, status, usage, error, incomplete_details },
      envelope,
      events: { data: parsed?.events, framing: parsed?.framing },
      parseError: parsed?.parseError,
      error: step.error,
      skipped: step.skipped,
    };
  });
}

export function compareCase(scenario, token, opencodex) {
  const a = comparisonView(token);
  const b = comparisonView(opencodex);
  const diff = differences(a, b);
  const groups = { request: 0, response: 0, envelope: 0, events: 0 };
  for (const entry of diff) {
    const group = entry.path.includes(".providerRequests") ? "request" : entry.path.includes(".events") ? "events" : entry.path.includes(".envelope") ? "envelope" : "response";
    entry.group = group;
    groups[group]++;
  }
  const errors = [token, opencodex].flatMap(result => {
    const list = [];
    if (result.error) list.push(`${result.engine}: ${result.error.message}`);
    if (result.cleanupError) list.push(`${result.engine}: cleanup: ${result.cleanupError}`);
    if (result.outboundViolations?.length) list.push(`${result.engine}: unexpected outbound requests`);
    for (const [index, step] of (result.steps ?? []).entries()) if (step.error) list.push(`${result.engine} step ${index + 1}: ${step.error.message}`);
    return list;
  });
  return { id: scenario.id, tags: scenario.tags, groups, differences: diff, errors,
    statuses: { token: (token.steps ?? []).map(step => step.response?.status ?? null), opencodex: (opencodex.steps ?? []).map(step => step.response?.status ?? null) },
    artifacts: { scenario: `cases/${scenario.id}/scenario.json`, token: `cases/${scenario.id}/token.json`, opencodex: `cases/${scenario.id}/opencodex.json` },
  };
}

export async function writeReport(directory, manifest, cases) {
  const coverage = Object.create(null);
  for (const entry of cases) for (const tag of entry.tags) {
    coverage[tag] ??= { cases: 0, differing: 0, executionErrors: 0 };
    coverage[tag].cases++;
    if (entry.differences.length) coverage[tag].differing++;
    if (entry.errors.length) coverage[tag].executionErrors++;
  }
  const report = { schemaVersion: 1, manifest, summary: {
    cases: cases.length, differingCases: cases.filter(item => item.differences.length).length,
    executionErrors: cases.filter(item => item.errors.length).length,
    differences: cases.reduce((sum, item) => sum + item.differences.length, 0),
  }, coverage, cases };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  for (const entry of cases) {
    const fields = entry.differences.flatMap(difference => [
      `### \`${difference.group}: ${difference.path.replaceAll("`", "\\`")}\``,
      "",
      "Token:",
      "```json",
      JSON.stringify(difference.token, null, 2),
      "```",
      "",
      "opencodex:",
      "```json",
      JSON.stringify(difference.opencodex, null, 2),
      "```",
      "",
    ]);
    const caseDirectory = join(directory, "cases", entry.id);
    await writeFile(join(caseDirectory, "diff.md"), [
      `# ${entry.id}`,
      "",
      `标签：${entry.tags.join(" · ") || "无"}`,
      "",
      `差异：${entry.differences.length} 项；执行错误：${entry.errors.length} 项。`,
      "",
      ...entry.errors.flatMap(error => [`- 执行错误：${error}`]),
      ...(entry.errors.length ? [""] : []),
      ...(fields.length ? fields : ["双方没有字段差异。"]),
    ].join("\n"));
  }
  const md = ["# Responses → OpenAI Chat comparison", "", `Cases: ${report.summary.cases}; differing: ${report.summary.differingCases}; execution errors: ${report.summary.executionErrors}.`, "",
    "Differences are observations, not correctness verdicts. Counts describe this corpus, not source-code coverage.", "",
    "| Case | Token / opencodex HTTP | Request | Response | Envelope | SSE events |", "|---|---|---:|---:|---:|---:|",
    ...cases.map(item => `| [${item.id}](cases/${item.id}/diff.md)${item.errors.length ? " ⚠" : ""} | ${item.statuses.token.join(",")} / ${item.statuses.opencodex.join(",")} | ${item.groups.request} | ${item.groups.response} | ${item.groups.envelope} | ${item.groups.events} |`),
    "", "Open report.html for searchable field-level differences and raw artifacts.",
  ].join("\n");
  await writeFile(join(directory, "report.md"), md);
  const data = JSON.stringify(report).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  await writeFile(join(directory, "report.html"), `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Protocol comparison</title>
<style>body{font:15px/1.55 system-ui;margin:32px auto;max-width:1400px;padding:0 20px;background:#f5f6f8;color:#182230}h1{font-size:26px}input,select{padding:10px;border:1px solid #bcc5d1;border-radius:6px;margin:4px}input{min-width:300px}details{background:white;border:1px solid #d9dfe8;border-radius:8px;margin:10px 0;padding:12px}summary{cursor:pointer;font-weight:600}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;vertical-align:top;border:1px solid #d9dfe8;padding:8px;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace;margin:0}a{color:#175cc0;margin-right:12px}.muted{color:#59677b}.error{color:#a02828}.tag{font-size:12px;color:#59677b}</style>
<h1>Responses → OpenAI Chat</h1><p id="summary"></p><p class="muted">逐字段比较两个实现。差异不代表缺陷；仅规范化 Responses 的生成 ID 和时间。工具 call_id、文本、reasoning 和控制字段保持原值。</p>
<input id="query" aria-label="搜索场景或字段" placeholder="搜索场景、标签、字段或值"><select id="group" aria-label="差异分组"><option value="all">全部差异</option><option value="request">Chat 请求</option><option value="response">Responses 结果</option><option value="envelope">响应配置字段</option><option value="events">SSE 事件</option><option value="errors">执行错误</option></select><label><input id="changed" type="checkbox" checked style="min-width:0">只显示差异</label>
<details><summary>运行版本与覆盖清单</summary><pre id="manifest"></pre></details><div id="cases"></div>
<script type="application/json" id="data">${data}</script><script>
const report=JSON.parse(document.getElementById('data').textContent);const el=id=>document.getElementById(id);const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e};
el('summary').textContent=report.summary.cases+' 个场景 · '+report.summary.differingCases+' 个存在差异 · '+report.summary.executionErrors+' 个执行错误';el('manifest').textContent=JSON.stringify({manifest:report.manifest,coverage:report.coverage},null,2);
const value=v=>v.present?JSON.stringify(v.value,null,2):'<absent>';
function render(){el('cases').replaceChildren();const q=el('query').value.toLowerCase(),g=el('group').value;for(const c of report.cases){const ds=c.differences.filter(d=>(g==='all'||d.group===g)&&(!q||JSON.stringify(d).toLowerCase().includes(q)||c.id.toLowerCase().includes(q)||c.tags.join(' ').includes(q)));if(g==='errors'?!c.errors.length:(el('changed').checked&&!ds.length&&!c.errors.length))continue;if(q&&!ds.length&&!JSON.stringify(c).toLowerCase().includes(q))continue;const box=node('details');box.append(node('summary',c.id+' · '+ds.length+' differences · HTTP '+c.statuses.token.join(',')+' / '+c.statuses.opencodex.join(',')));box.append(node('p',c.tags.join(' · ')));for(const [name,path]of Object.entries(c.artifacts)){const a=node('a',name+'.json');a.href=path;box.append(a)}if(c.errors.length){const p=node('p',c.errors.join('\n'));p.className='error';box.append(p)}let loaded=false;box.addEventListener('toggle',()=>{if(!box.open||loaded)return;loaded=true;const table=node('table');const head=node('tr');for(const s of ['Path','Token','opencodex'])head.append(node('th',s));table.append(head);for(const d of ds.slice(0,500)){const row=node('tr');for(const s of [d.path,value(d.token),value(d.opencodex)]){const cell=node('td');cell.append(node('pre',s));row.append(cell)}table.append(row)}box.append(table);if(ds.length>500)box.append(node('p','显示前 500 个差异；完整结果见 report.json。'))});el('cases').append(box)}}
for(const id of ['query','group','changed'])el(id).addEventListener('input',render);render();
</script></html>`);
  return report;
}
