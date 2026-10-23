#!/usr/bin/env node
/**
 * mcd-points-strategist · 数据采集器
 *
 * 拉取麦当劳 MCP 的积分账户、积分商城、抽奖、活动日历、优惠券数据，
 * 输出脱敏后的快照到 fixtures/。
 *
 * 用法：
 *   MCP_TOKEN=your_token node scripts/fetch-mcd-data.mjs
 *   MCP_TOKEN=your_token node scripts/fetch-mcd-data.mjs --out fixtures/snapshot.json
 *
 * 说明：
 *   - 传输层为 Streamable HTTP，工具调用走 JSON-RPC 2.0 over POST。
 *   - 脱敏：剔除 accountId / orderId / storeCode / beCode / 手机号 / 地址等标识，
 *     积分与商品等业务字段保留（它们是算法输入）。
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MCP_URL = process.env.MCP_MCP_URL || "https://mcp.mcd.cn";
const TOKEN = process.env.MCP_TOKEN || "";
const OUT = resolve(process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "fixtures/mcd-snapshot.json");

if (!TOKEN) {
  console.error("缺少环境变量 MCP_TOKEN。请先到 https://open.mcd.cn/mcp 控制台申请 Token。");
  process.exit(1);
}

let rpcId = 0;

async function rpc(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  return res.json();
}

async function callTool(name, args = {}) {
  const body = await rpc("tools/call", { name, arguments: args });
  if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  const result = body.result || {};
  const text = (result.content || []).map((c) => c.text || "").join("");
  if (result.isError) throw new Error(`${name} 返回错误: ${text.slice(0, 200)}`);
  const payload = text.includes("## Original Response")
    ? text.split("## Original Response")[1].trim()
    : text;
  try {
    return JSON.parse(payload);
  } catch {
    return text;
  }
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcd-points-strategist", version: "1.0.0" },
  });

  const [account, mall, lottery, prizes, coupons, campaigns] = await Promise.all([
    callTool("query-my-account"),
    callTool("mall-points-products"),
    callTool("query-lottery-info"),
    callTool("query-my-prizes"),
    callTool("available-coupons"),
    callTool("campaign-calendar"),
  ]);

  const snapshot = {
    _generatedAt: new Date().toISOString(),
    _source: "McDonald's China MCP Server (https://mcp.mcd.cn)",
    _note: "本文件为脱敏快照，仅保留算法所需的业务字段。",
    account: sanitizeAccount(account),
    mall: sanitizeMall(mall),
    lottery: sanitizeLottery(lottery),
    prizes: sanitizePrizes(prizes),
    coupons: sanitizeCoupons(coupons),
    campaigns: sanitizeCampaigns(campaigns),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`已写入 ${OUT}`);
  console.log(`可用积分 ${snapshot.account?.availablePoint ?? "?"} / 累计 ${snapshot.account?.accumulativePoint ?? "?"} / 已过期 ${snapshot.account?.expiredPoint ?? "?"}`);
  console.log(`积分商城标的 ${snapshot.mall?.length ?? 0} 件`);
}

function sanitizeAccount(raw) {
  const d = raw?.data || {};
  return {
    availablePoint: num(d.availablePoint),
    accumulativePoint: num(d.accumulativePoint),
    usedPoint: num(d.usedPoint),
    expiredPoint: num(d.expiredPoint),
    frozenPoint: num(d.frozenPoint),
    currentMouthExpirePoint: num(d.currentMouthExpirePoint),
    nextMouthExpirePoint: num(d.nextMouthExpirePoint),
    currency: d.currency || "麦享会积分",
  };
}

function sanitizeMall(raw) {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  const now = new Date();
  return list.map((it) => {
    const point = num(it.point);
    // 关键：积分类标的的 price 字段恒为 0，真实面值藏在 spuName 前缀（如「18.8元2份麦辣鸡翅」）
    const faceValue = parseFaceValue(it.spuName, it.price);
    const up = parseTime(it.upTime);
    const down = parseTime(it.downTime);
    return {
      spuId: it.spuId,
      spuName: it.spuName,
      point,
      faceValue: faceValue.value,
      faceValueSource: faceValue.source,
      catName: it.catName,
      shopId: it.shopId,
      selling: it.selling || "",
      upTime: it.upTime,
      downTime: it.downTime,
      // 上下架状态：MCP 返回的列表含大量已过期标的，不剔除会得出错误结论
      status: down !== null && down < now ? "expired" : up !== null && up > now ? "upcoming" : "live",
      imageUrl: it.spuImage || "",
    };
  });
}

/**
 * 解析标的面值（元）。
 * 优先从 spuName 前缀取（「18.8元2份麦辣鸡翅」→ 18.8）；
 * 其次从 selling 描述取；最后回落到 price 字段（仅派对等现金类有效）。
 */
function parseFaceValue(name, priceField) {
  const fromName = /^([\d.]+)\s*元/.exec(name || "");
  if (fromName) return { value: num(fromName[1]), source: "spuName" };
  const p = num(priceField);
  if (p > 0) return { value: p, source: "priceField" };
  return { value: 0, source: "unknown" };
}

function parseTime(s) {
  if (!s) return null;
  const t = new Date(s.replace(" ", "T"));
  return Number.isNaN(t.getTime()) ? null : t;
}

function sanitizeLottery(raw) {
  const d = raw?.data || {};
  return {
    activityName: d.activityName,
    activityStatusText: d.activityStatusText,
    drawPoint: num(d.drawPoint),
    drawTypeText: d.drawTypeText,
    availablePoint: num(d.availablePoint),
    availableTimes: d.availableTimes ?? null,
    beginTime: d.beginTime,
    endTime: d.endTime,
    prizes: (d.prizes || []).map((p) => ({
      name: p.name,
      typeText: p.typeText,
      imageUrl: p.imageUrl,
    })),
  };
}

function sanitizePrizes(raw) {
  const list = raw?.data?.prizes || [];
  return list.map((p) => ({
    name: p.name,
    statusText: p.statusText,
    recordTime: p.recordTime,
  }));
}

function sanitizeCoupons(raw) {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const titles = [...text.matchAll(/优惠券标题：(.+?)\s*\\?$/gm)].map((m) => m[1].trim());
  return titles.map((t) => ({ title: t, status: "可领取" }));
}

function sanitizeCampaigns(raw) {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const out = [];
  const re = /####\s*(\d{4}年\d{1,2}月\d{1,2}日)\s*(\S+)\s*\n+\n-\s+\*\*活动标题\*\*：(.+?)\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ date: m[1], phase: m[2], title: m[3].trim() });
  }
  return out;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

main().catch((err) => {
  console.error("采集失败:", err.message);
  process.exit(1);
});
