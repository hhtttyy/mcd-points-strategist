#!/usr/bin/env node
/**
 * mcd-points-strategist · MCP 能力探测器
 *
 * 为什么要它：官方文档只列了 33 个工具名，**没说清楚每个工具实际返回什么**。
 * 实测踩到的坑（详见 references/mcp-pitfalls.md）：
 *   - 返回体不是 JSON，是 Markdown，真 JSON 藏在 `## Original Response` 之后
 *   - `list-nutrition-foods` 的 data 是逗号分隔文本表格，不是 JSON
 *   - 无数据时返回中文文案（如「暂无可用优惠券」），不是空数组
 *   - `campaign-calendar` 必传 specifiedDate
 *   - `query-promotions` **不在官方文档里**，是这个脚本发现的
 *   - `query-nearby-stores` 必传 beType + searchType
 *   - 金额单位是「分」，且两个接口方向相反
 *
 * 用法：
 *   MCD_MCP_TOKEN=xxx node scripts/app/explore.mjs
 *   MCD_MCP_TOKEN=xxx node scripts/app/explore.mjs --store 1990622  # 带上门店串联
 *   MCD_MCP_TOKEN=xxx node scripts/app/explore.mjs --no-arg-only   # 跳过需参工具
 *
 * 安全：写操作工具（领券/下单/兑换/抽奖）**一律不调用**，只展示参数定义。
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpClient, WRITE_TOOLS, rawText } from "../lib/mcp-client.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const OUT_MD = resolve(ROOT, "references/mcp-explorer.md");
const OUT_JSON = resolve(ROOT, "references/mcp-explorer.json");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const STORE = arg("store", null);
const SKIP_ARG_TOOLS = has("no-arg-only");

/** 判���返回形态 —— 这是本脚本最有价值的产出。 */
function classifyShape(result) {
  if (result === null || result === undefined) return "empty";
  if (typeof result === "object" && !Array.isArray(result)) {
    const keys = Object.keys(result);
    if (keys.includes("data") || keys.includes("success") || keys.includes("code")) return "json";
    if (keys.length === 0) return "empty";
    return "json";
  }
  if (Array.isArray(result)) return "json";
  const text = String(result);
  if (text.includes("## Original Response")) return "markdown-wrapper";
  if (/^[|,\t]/m.test(text) || /^[^\n]*\t[^\n]+$/m.test(text)) return "text-table";
  if (/^\s*[#{*\-\d]/.test(text)) return "markdown";
  if (/^[\s]*[\u4e00-\u9fa5]/.test(text) && !text.includes("{")) return "empty-cn";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "text";
  }
}

/** 估算数据条数。 */
function countRows(result) {
  if (result === null || result === undefined) return 0;
  if (Array.isArray(result)) return result.length;
  if (typeof result === "object") {
    const d = result.data;
    if (Array.isArray(d)) return d.length;
    if (d && typeof d === "object") {
      for (const k of ["list", "prizes", "items", "productList"]) {
        if (Array.isArray(d[k])) return d[k].length;
      }
      if (Array.isArray(d.dailyList)) return d.dailyList.length;
      return 1;
    }
    return 1;
  }
  const text = String(result);
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length > 3) return lines.length;
  return 0;
}

async function main() {
  const client = new McpClient();
  await client.initialize();
  const tools = await client.listTools();
  console.log(`共 ${tools.length} 个工具，开始探测…`);

  const report = { generatedAt: new Date().toISOString(), tools: [] };
  const errors = [];

  // 无参工具：直接调
  const noArg = tools.filter((t) => !(t.inputSchema?.required || []).length);

  // 需参工具：用已探测到的值串联
  let storeCode = STORE;
  let orderId = null;
  let spuId = null;

  for (const t of tools) {
    const name = t.name;
    if (WRITE_TOOLS.has(name)) {
      report.tools.push({
        name,
        status: "skipped-write",
        reason: "写操作，探测阶段绝不调用",
        required: t.inputSchema?.required || [],
        properties: Object.fromEntries(
          Object.entries(t.inputSchema?.properties || {}).map(([k, v]) => [k, v.type || "any"])
        ),
      });
      continue;
    }

    let args = {};
    const req = t.inputSchema?.required || [];
    const props = Object.keys(t.inputSchema?.properties || {});

    if (req.length) {
      if (SKIP_ARG_TOOLS) {
        report.tools.push({ name, status: "skipped-needs-args", required: req });
        continue;
      }
      // 尝试用已探测到的值串联
      if (props.includes("storeCode")) {
        if (!storeCode) {
          report.tools.push({ name, status: "skipped-no-storeCode", required: req });
          continue;
        }
        args.storeCode = storeCode;
      }
      if (props.includes("orderType")) args.orderType = 1;
      if (props.includes("beType")) args.beType = 1;
      if (props.includes("orderId") && orderId) args.orderId = orderId;
      if (props.includes("spuId") && spuId) args.spuId = spuId;
      if (props.includes("code") && storeCode) args.code = storeCode;
      if (props.includes("dateStr")) args.dateStr = new Date().toISOString().slice(0, 10);

      const missing = req.filter((r) => args[r] === undefined);
      if (missing.length) {
        report.tools.push({ name, status: "skipped-missing-args", required: req, missing });
        continue;
      }
    }

    try {
      const res = await client.callTool(name, args);
      const shape = classifyShape(res);
      const rows = countRows(res);
      const text = rawText(res);
      report.tools.push({
        name,
        status: "ok",
        args,
        shape,
        rows,
        bytes: text.length,
        undocumented: !name.startsWith("query-") && !name.startsWith("mall-") ? false : false,
      });
      console.log(`  ✓ ${name}  ${shape}  ${rows} 行  ${text.length}B`);

      // 串联：把返回值里的可用标识抓出来喂给后续工具
      if (name === "order-list" && !orderId) {
        const list = res?.data?.list || res?.list || [];
        if (list[0]?.orderId) orderId = String(list[0].orderId);
      }
      if (name === "mall-points-products" && !spuId) {
        const list = res?.data || [];
        if (list[0]?.spuId) spuId = list[0].spuId;
      }
      if (name === "query-nearby-stores" && !storeCode) {
        const m = text.match(/[（(]\s*(\d{7})\s*[)）]/);
        if (m) storeCode = m[1];
      }
    } catch (e) {
      errors.push({ name, error: String(e?.message || e).slice(0, 200) });
      report.tools.push({ name, status: "failed", args, error: String(e?.message || e).slice(0, 200) });
      console.log(`  ✗ ${name}  ${String(e?.message || e).slice(0, 80)}`);
    }
  }

  await mkdir(dirname(OUT_MD), { recursive: true });
  await writeFile(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(OUT_MD, renderMarkdown(report, tools), "utf8");

  const ok = report.tools.filter((t) => t.status === "ok").length;
  console.log(`\n✓ 探测完成：${ok}/${tools.length} 个工具成功调用`);
  console.log(`  报告 → ${OUT_MD.replace(ROOT + "/", "")}`);
  if (errors.length) console.log(`  ${errors.length} 个失败（见报告）`);
}

function renderMarkdown(report, tools) {
  const L = [];
  L.push("# 麦当劳 MCP 能力探测报告");
  L.push("");
  L.push(`由 \`scripts/app/explore.mjs\` 实时调用生成 · ${report.generatedAt}`);
  L.push("");
  L.push(`官方文档列出 ${tools.length} 个工具，服务端实际暴露的工具数以 \`tools/list\` 为准。`);
  L.push("");

  const ok = report.tools.filter((t) => t.status === "ok");
  const skipped = report.tools.filter((t) => t.status.startsWith("skipped"));
  const writes = report.tools.filter((t) => t.status === "skipped-write");
  const failed = report.tools.filter((t) => t.status === "failed");

  L.push("## 总览");
  L.push("");
  L.push("| 类别 | 数量 |");
  L.push("|---|---:|");
  L.push(`| 调用成功 | ${ok.length} |`);
  L.push(`| 需参数未取到值 | ${skipped.filter((s) => s.status !== "skipped-write").length} |`);
  L.push(`| 写操作（安全跳过） | ${writes.length} |`);
  L.push(`| 调用失败 | ${failed.length} |`);
  L.push("");

  L.push("## 调用成功的工具");
  L.push("");
  L.push("| Tool | 入参 | 返回形态 | 数据条数 | 响应大小 |");
  L.push("|---|---|---|---:|---:|");
  for (const t of ok) {
    L.push(`| \`${t.name}\` | ${Object.keys(t.args || {}).length ? JSON.stringify(t.args) : "无"} | ${t.shape} | ${t.rows} | ${t.bytes} |`);
  }
  L.push("");

  if (skipped.length) {
    L.push("## 需要参数（本次未取到值）");
    L.push("");
    L.push("| Tool | 缺少 | 参数定义 |");
    L.push("|---|---|---|");
    for (const t of skipped.filter((s) => s.status !== "skipped-write")) {
      L.push(`| \`${t.name}\` | ${(t.missing || t.required || []).join(", ")} | ${(t.required || []).join(", ")} |`);
    }
    L.push("");
  }

  if (writes.length) {
    L.push("## 写操作（安全起见不调用）");
    L.push("");
    L.push("| Tool | 必填入参 |");
    L.push("|---|---|");
    for (const t of writes) {
      L.push(`| \`${t.name}\` | ${(t.required || []).join(", ") || "—"} |`);
    }
    L.push("");
  }

  if (failed.length) {
    L.push("## 调用失败");
    L.push("");
    for (const t of failed) L.push(`- \`${t.name}\`：${t.error}`);
    L.push("");
  }

  L.push("## 返回形态说明");
  L.push("");
  L.push("- **markdown-wrapper** —— 返回 Markdown，真 JSON 在 `## Original Response` 之后");
  L.push("- **text-table** —— 逗号分隔文本表格，不是 JSON");
  L.push("- **empty-cn** —— 无数据时返回中文文案，不是空数组");
  L.push("- **markdown** —— 纯 Markdown（活动日历、券列表）");
  L.push("- **json** —— 标准 JSON");
  L.push("");
  L.push("> 这些行为官方文档均未说明，均为实测所得。");
  L.push("> 写操作工具（下单/取消/抽奖/兑换/领券）本脚本一律不调用，仅展示参数定义。");
  L.push("");
  return L.join("\n");
}

main().catch((e) => {
  console.error("探测失败：", e.message);
  process.exit(1);
});
