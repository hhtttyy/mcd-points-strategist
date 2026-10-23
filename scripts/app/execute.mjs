#!/usr/bin/env node
/**
 * mcd-points-strategist · 写操作确认网关
 *
 * 所有会改动账号状态的操作**必须经过这里**。设计原则：
 *
 *   1. **先展示，后执行** —— 执行前必须打印清单与代价
 *   2. **显式确认** —— 必须带 `--confirm`，且确认串要匹配动作
 *   3. **默认拒绝** —— 不带 `--confirm` 时只打印计划，不执行
 *   4. **执行后记账** —— 每次执行写一条账本记录，供复盘回校
 *
 * 用法：
 *   node scripts/app/execute.mjs claim                    # 只看计划
 *   node scripts/app/execute.mjs claim --confirm           # 确认执行
 *   node scripts/app/execute.mjs redeem --sku 2001 --confirm
 *   node scripts/app/execute.mjs draw --confirm
 *   node scripts/app/execute.mjs ledger                    # 看账本
 *   node scripts/app/execute.mjs ledger --csv
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpClient } from "../lib/mcp-client.mjs";
import { makeRecord, parseLedger, reviewLedger, toCsv } from "../analyze/ledger.mjs";
import { diffSnapshots } from "../analyze/diff.mjs";
import { normalizeSnapshot } from "../collect/normalize.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA = resolve(ROOT, "data");
const LEDGER = resolve(DATA, "ledger.jsonl");
const SNAPSHOT = resolve(DATA, "snapshot.json");
const PREV = resolve(DATA, "snapshot.prev.json");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function appendRecord(record) {
  await mkdir(dirname(LEDGER), { recursive: true });
  await appendFile(LEDGER, `${JSON.stringify(record)}\n`, "utf8");
}

// --------------------------------------------------------------------------
// 动作定义
// --------------------------------------------------------------------------

/**
 * 每个动作声明：叫什么、要什么参数、代价是什么、执行时调哪个 MCP 工具。
 *
 * `cost` 是**执行前必须告诉用户**的代价 —— 用户在确认界面上看到的就是它。
 */
const ACTIONS = {
  claim: {
    label: "一键领券",
    tool: "auto-bind-coupons",
    args: () => ({}),
    cost: () => "不消耗积分，不产生消费。领到的券进入你的麦享会卡包。",
    plan: async (snapshot) => {
      const claimable = (snapshot?.coupons || []).filter((c) => c.status === "可领取");
      if (!claimable.length) return { ok: false, reason: "当前没有可领取的券" };
      return {
        ok: true,
        items: claimable.map((c) => c.name),
        detail: `${claimable.length} 张：${claimable.map((c) => c.name).join("、")}`,
      };
    },
  },

  redeem: {
    label: "积分兑换",
    tool: "mall-create-order",
    args: (opts) => ({ skuId: opts.sku, spuCategory: opts.category || "虚拟商品" }),
    cost: (opts) => {
      const item = (opts.snapshot?.mall || []).find((m) => String(m.spuId) === String(opts.sku));
      const pts = item?.points ?? "未知";
      const face = item?.faceValue ?? "?";
      return `消耗 ${pts} 积分，换到面值约 ¥${face}。每件商品单独成单。`;
    },
    plan: async (snapshot, opts) => {
      const item = (snapshot?.mall || []).find((m) => String(m.spuId) === String(opts.sku));
      if (!item) return { ok: false, reason: `商城里没有 spuId=${opts.sku} 的标的` };
      if (item.status !== "live") {
        return { ok: false, reason: `「${item.name}」已于 ${item.downAt} 下架，不要为它攒分` };
      }
      const acc = snapshot?.account;
      if (acc && item.points > acc.available) {
        return {
          ok: false,
          reason: `可用积分 ${acc.available} 不足，需要 ${item.points} 分（差 ${item.points - acc.available}）`,
        };
      }
      return {
        ok: true,
        items: [item.name],
        detail: `${item.name} · ${item.points} 积分 → 面值 ¥${item.faceValue}（密度 ${(item.faceValue / item.points).toFixed(4)} 元/分）`,
        gainYuan: item.faceValue,
        costPoints: item.points,
        target: item.name,
      };
    },
  },

  draw: {
    label: "积分抽奖",
    tool: "draw-lottery",
    args: () => ({}),
    cost: (opts) => {
      const lp = opts.snapshot?.lottery?.drawPoint ?? "未知";
      const acc = opts.snapshot?.account?.available ?? 0;
      return `每次消耗 ${lp} 积分，当前余额可抽 ${Math.floor(acc / (lp || 1))} 次。中奖概率官方未公布。`;
    },
    plan: async (snapshot) => {
      const l = snapshot?.lottery;
      if (!l || !l.drawPoint) return { ok: false, reason: "当前没有进行中的积分抽奖活动" };
      if (l.resourceEligible === false) {
        return { ok: false, reason: `暂不可参与：${l.ineligibleReason || "资源不足"}` };
      }
      const acc = snapshot?.account?.available ?? 0;
      return {
        ok: true,
        items: (l.prizes || []).slice(0, 5).map((p) => p.name),
        detail: `${l.name} · 每次 ${l.drawPoint} 积分 · 可抽 ${Math.floor(acc / l.drawPoint)} 次`,
        costPoints: l.drawPoint,
        target: l.name,
      };
    },
  },
};

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  const opts = {
    sku: arg("sku"),
    category: arg("category"),
    snapshot: await readJson(SNAPSHOT).then((s) => (s ? normalizeSnapshot(s) : null)),
  };

  if (cmd === "ledger") return showLedger();
  if (cmd === "review") return showReview(opts.snapshot);

  const action = ACTIONS[cmd];
  if (!action) {
    console.log("用法：execute.mjs claim | redeem --sku <spuId> | draw | ledger | review");
    console.log("      加 --confirm 才真正执行；不加只打印计划");
    return;
  }

  const plan = await action.plan(opts.snapshot, opts);

  if (!plan.ok) {
    console.log(`✗ ${action.label} 无法执行：${plan.reason}`);
    return;
  }

  // ── 展示计划（永远先展示）──
  console.log("┌──────────────────────────────────────────────┐");
  console.log(`│  ${action.label} · 执行计划                        │`);
  console.log("└──────────────────────────────────────────────┘");
  console.log(plan.detail);
  console.log("");
  console.log(`代价：${action.cost(opts)}`);
  console.log("");

  if (!has("confirm")) {
    console.log("这是计划，未执行。确认无误后加 --confirm 再跑一次。");
    return;
  }

  // ── 执行 ──
  const client = new McpClient();
  await client.initialize();
  const res = await client.callTool(action.tool, action.args(opts), { allowWrite: true });

  console.log("✓ 已执行");
  const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
  console.log(text.slice(0, 800));
  console.log("");

  // ── 记账 ──
  const record = makeRecord(cmd, {
    target: plan.target ?? plan.items?.[0] ?? null,
    costPoints: plan.costPoints ?? 0,
    costYuan: 0,
    gainYuan: plan.gainYuan ?? 0,
    note: plan.detail,
    meta: { tool: action.tool, items: plan.items },
  });
  await appendRecord(record);
  console.log(`✓ 已记账 → ${LEDGER.replace(ROOT + "/", "")}`);

  // ── 记录领券时刻（供 App 可见性诊断用）──
  // 服务端返回的 datetime 是「券实际到账的时刻」，
  // 与卡包里券的 receiveTime 一致 → 用来判断
  // 「这张券是不是刚领的、App 侧可能还没同步」。
  if (cmd === "claim") {
    const claimAt = res?.datetime || res?.data?.datetime || new Date().toISOString();
    try {
      await writeFile(
        resolve(DATA, "last-claim.json"),
        `${JSON.stringify({ claimAt, at: new Date().toISOString() }, null, 2)}\n`,
        "utf8"
      );
      console.log(`✓ 已记录领券时刻 ${claimAt} → data/last-claim.json`);
    } catch {
      /* 记录失败不影响主流程 */
    }
  }
}

async function showLedger() {
  let text = "";
  try {
    text = await readFile(LEDGER, "utf8");
  } catch {
    /* 账本还不存在 */
  }
  const records = parseLedger(text);
  if (has("csv")) {
    console.log(toCsv(records));
    return;
  }
  if (!records.length) {
    console.log("账本还是空的。执行一次动作（claim / redeem / draw）后会自动记录。");
    return;
  }
  console.log(`账本共 ${records.length} 条记录：\n`);
  for (const r of records) {
    const cost = r.costPoints ? ` -${r.costPoints}分` : "";
    const gain = r.gainYuan ? ` +¥${r.gainYuan}` : "";
    console.log(`  ${r.ts.slice(0, 16).replace("T", " ")}  ${r.action}${cost}${gain}  ${r.target || r.note || ""}`);
  }
}

async function showReview(snapshot) {
  let text = "";
  try {
    text = await readFile(LEDGER, "utf8");
  } catch {
    /* 空账本 */
  }
  const records = parseLedger(text);
  const prev = await readJson(PREV);
  const prevNorm = prev ? normalizeSnapshot(prev) : null;

  // ⚠️ earnRate 的分母只能用**本期新增**的订单，不是全部历史。
  // 用全部历史会算出 581 分 / 全部历史消费 这种无意义的数。
  const diff = diffSnapshots(prevNorm, snapshot, { now: new Date() });
  const newOrders = diff.newOrders || [];

  const review = reviewLedger(records, {
    currentAccount: snapshot?.account,
    prevAccount: prevNorm?.account,
    orders: newOrders,
    defaultEarnRate: 1,
  });

  console.log("┌──────────────────────────────────────────────┐");
  console.log("│        📈 麦门复盘 · Review                    │");
  console.log("└──────────────────────────────────────────────┘");
  console.log(review.narrative);
  console.log("");

  if (review.calibration.earnRate) {
    const c = review.calibration;
    console.log("💰 earnRate 校准");
    console.log(`  实测 ${c.earnRate} 积分/元（本期 +${c.pointsDelta} 分 / ¥${c.spend}，${c.sampleSize} 单）`);
    console.log(`  置信度：${c.confidence}`);
    console.log("");
  } else {
    console.log(`💰 earnRate 尚无法校准：${review.calibration.note}`);
    console.log("");
  }

  if (review.deviations.length) {
    console.log("🔍 与原先假设的偏差");
    for (const d of review.deviations) {
      console.log(`  · ${d.text}`);
      if (d.impact) console.log(`    → ${d.impact}`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
