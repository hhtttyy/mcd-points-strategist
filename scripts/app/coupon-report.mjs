#!/usr/bin/env node
/**
 * mcd-points-strategist · 券分析入口
 *
 * 把采集到的券与历史订单喂给券引擎，产出**可执行结论**：
 *   券体检 + 沉默成本 + 同款不同价 + 用券排程
 *
 * 用法：
 *   node scripts/app/coupon-report.mjs              # 读 data/snapshot.json
 *   node scripts/app/coupon-report.mjs --json       # 结构化输出
 *   node scripts/app/coupon-report.mjs --channel pickup   # 按到店场景判定可用性
 *
 * 纯计算，不发起网络请求。
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { auditCoupons } from "../analyze/coupon-audit.mjs";
import { forecastOrders, scheduleCoupons } from "../analyze/coupon-schedule.mjs";
import { classify, parseCouponTerms } from "../analyze/coupon-model.mjs";
import { normalizeSnapshot } from "../collect/normalize.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SNAPSHOT = resolve(ROOT, arg("snapshot", "data/snapshot.json"));
const CHANNEL = arg("channel", null);
const HOUR = arg("hour", null);
const wantJson = process.argv.includes("--json");

/** 给券补上类型判定与券面解析结果 —— 引擎需要这两个字段。 */
function enrich(coupon) {
  const c = classify(coupon);
  const terms = parseCouponTerms(coupon);
  return {
    ...coupon,
    type: c.type,
    typeConfident: c.confident,
    typeReason: c.reason,
    threshold: terms.threshold,
    discountPct: terms.discountPct,
    // 面值：优先用券自带的 value（来自 query-my-coupons 的「优惠」字段），
    // 没有时才用券面解析结果
    faceValue: coupon.value > 0 ? coupon.value : terms.faceValue,
    valueUnknown: terms.unknown,
  };
}

async function main() {
  let snap;
  try {
    snap = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  } catch {
    console.error(
      `读不到快照：${SNAPSHOT.replace(ROOT + "/", "")}\n` +
        `先跑一次采集：MCD_MCP_TOKEN=<你的Token> node scripts/app/collect.mjs`
    );
    process.exit(1);
  }

  // 归一化：兼容早期版本的快照字段名
  snap = normalizeSnapshot(snap);

  const now = new Date();
  const coupons = (snap.coupons || []).map(enrich);
  const opts = { now, channel: CHANNEL, hour: HOUR !== null ? Number(HOUR) : undefined };

  const audit = auditCoupons(coupons, opts);
  const forecast = forecastOrders(snap.orders || [], { now });
  const schedule = scheduleCoupons(coupons, forecast.orders, { now });

  const result = {
    generatedAt: now.toISOString(),
    channel: CHANNEL,
    audit,
    forecast,
    schedule,
  };

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  render(result);
}

function render(r) {
  const L = [];
  const a = r.audit;
  const s = r.schedule;

  L.push("┌──────────────────────────────────────────────┐");
  L.push("│        🎫 麦门券体检 · Coupon Report          │");
  L.push("└──────────────────────────────────────────────┘");
  L.push(`生成时间：${r.generatedAt.slice(0, 16).replace("T", " ")}`);
  L.push("");

  // ---- 概览 ----
  L.push("📊 概览");
  L.push(`  ${a.narrative}`);
  L.push("");

  // ---- 沉默成本 ----
  if (a.silent.atRiskCount) {
    L.push("⚠️ 过期风险");
    for (const item of a.silent.atRiskItems) {
      const tags = [];
      if (item.dayWindow) tags.push(item.dayWindow);
      if (item.weekdayText) tags.push(item.weekdayText);
      if (item.channel?.length) {
        tags.push(item.channel.map((c) => (c === "pickup" ? "到店" : "外送")).join("/"));
      }
      const slotNote =
        item.usableDays !== null && item.unusableDays > 0
          ? `（仅 ${item.usableDays} 天能用，${item.unusableDays} 天用不了）`
          : "";
      L.push(
        `  · ${item.name}  ¥${item.value}  ${item.daysLeft < 0 ? "已过期" : `还剩 ${item.daysLeft} 天`}${slotNote}`
      );
      if (tags.length) L.push(`    ${tags.join(" · ")}`);
    }
    L.push("");
  }

  // ---- 当前用不了的券 ----
  if (a.unusable.length) {
    L.push("⏰ 当前用不了的券（不是过期，是时机不对）");
    for (const item of a.unusable) {
      L.push(`  · ${item.name}  ${item.reason}`);
    }
    L.push("");
  }

  // ---- 未领取 ----
  if (a.unclaimed.length) {
    L.push("🎫 未领取（领了才有机会用）");
    for (const item of a.unclaimed) L.push(`  · ${item.name}`);
    L.push("");
  }

  // ---- 同款不同价 ----
  if (a.duplicates.length) {
    L.push("💰 同款不同价（换便宜的那个）");
    for (const d of a.duplicates) {
      L.push(
        `  · ${d.name} —— ¥${d.dearest.value} 与 ¥${d.cheapest.value} 两个价，换便宜的省 ¥${d.waste}`
      );
    }
    L.push("");
  }

  // ---- 用券排程 ----
  L.push(`📅 用券排程（${r.forecast.note}）`);
  if (s.assignments.length) {
    for (const a2 of s.assignments) {
      const note = a2.note ? `  [${a2.note}]` : "";
      L.push(`  第 ${a2.orderIndex} 单 ${a2.date} ${a2.dowText} → ${a2.coupon}  ¥${a2.value}${note}`);
    }
  } else {
    L.push("  未来几次点餐都排不进券");
  }
  if (s.unassigned.length) {
    L.push("");
    L.push("  排不进去的券：");
    for (const u of s.unassigned) {
      L.push(`  · ${u.name}  ${u.reason}`);
    }
  }
  if (s.unclaimed?.length) {
    L.push("");
    L.push("  未领取（不参与排程，先领）：");
    for (const u of s.unclaimed) L.push(`  · ${u.name}`);
  }
  L.push("");
  L.push(
    `  覆盖率 ${Math.round(s.coverageRate * 100)}% · 排得出去 ¥${s.scheduledValue} · 排不出去 ¥${s.unassignedValue}`
  );
  L.push("");
  L.push("—— 以上均基于麦当劳官方 MCP 实时数据，以官方渠道为准 ——");
  console.log(L.join("\n"));
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
