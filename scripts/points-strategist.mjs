#!/usr/bin/env node
/**
 * mcd-points-strategist · 命令行入口
 *
 * 用法：
 *   node scripts/points-strategist.mjs                     # 用 fixtures 快照分析
 *   node scripts/points-strategist.mjs --budget 500        # 假设可用积分为 500
 *   node scripts/points-strategist.mjs --plan              # 输出兑换方案
 *   node scripts/points-strategist.mjs --json               # 输出 JSON
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  scoreHealth,
  rankByDensity,
  detectDeadlock,
  solveRedeemPlan,
  compareLotteryVsRedeem,
  buildActionPlan,
  planToTarget,
  estimateEarnRate,
  detectDelistedTrap,
} from "./points-engine.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const SNAPSHOT = resolve("fixtures/mcd-snapshot.json");

async function main() {
  let snap;
  try {
    snap = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  } catch {
    console.error(
      `未找到快照 ${SNAPSHOT}\n请先运行：MCP_TOKEN=xxx node scripts/fetch-mcd-data.mjs`
    );
    process.exit(1);
  }

  const account = { ...snap.account };
  const budget = Number(val("--budget", account.availablePoint));
  account.availablePoint = budget;
  const mall = snap.mall || [];

  const health = scoreHealth(account, mall);
  const ranked = rankByDensity(mall);
  const trap = detectDelistedTrap(mall);
  const deadlock = detectDeadlock(account, mall);
  const plan = solveRedeemPlan(mall, budget);
  const lottery = compareLotteryVsRedeem({
    availablePoint: budget,
    lottery: snap.lottery,
    mall,
  });
  const actions = buildActionPlan({
    account,
    mall,
    lottery: snap.lottery,
    coupons: snap.coupons || [],
  });

  if (has("--json")) {
    console.log(JSON.stringify({ health, trap, deadlock, plan, lottery, actions }, null, 2));
    return;
  }

  const line = "─".repeat(58);
  console.log(`\n麦麦积分资产分析  ·  预算 ${budget} 分\n${line}`);
  console.log(`健康度  ${health.score}/100  （${health.grade}）`);
  console.log(
    `  存活率 ${(health.dims.survival.value * 100).toFixed(1)}%  ` +
      `变现率 ${(health.dims.realization.value * 100).toFixed(1)}%  ` +
      `效率 ${(health.dims.efficiency.value * 100).toFixed(1)}%  ` +
      `临期安全度 ${(health.dims.vitality.value * 100).toFixed(1)}%`
  );
  console.log(
    `  累计 ${health.totals.accumulative} / 可用 ${health.totals.available} / ` +
      `已过期 ${health.totals.expired}  →  衰减率 ${(health.decayRate * 100).toFixed(1)}%`
  );

  console.log(`\n${line}\n商城清单体检`);
  console.log(`  返回 ${trap.total} 件，其中在售且可用积分兑换 ${trap.liveRedeemable} 件`);
  if (trap.expiredWithPoints > 0) {
    console.log(`  ⚠️  ${trap.warning}`);
    for (const s of trap.samples) {
      console.log(`      · ${s.spuName}（${s.point} 分，已于 ${s.downTime} 下架）`);
    }
  }

  console.log(`\n${line}\n在售兑换标的 · 积分价值密度排行`);
  for (const r of ranked) {
    console.log(
      `  ${r.spuName.padEnd(24)} ${String(r.point).padStart(4)} 分 → ¥${String(r.cashValue).padStart(5)}` +
        `   密度 ${r.density.toFixed(4)} 元/分`
    );
  }
  const redeemableRanked = ranked.filter((r) => r.redeemable);
  if (redeemableRanked.length >= 2) {
    const best = redeemableRanked[0];
    const worst = redeemableRanked[redeemableRanked.length - 1];
    console.log(
      `\n  ⚡ 边际收益率递减：最优档 ${best.point} 分（${best.density.toFixed(4)}）` +
        ` vs 最差档 ${worst.point} 分（${worst.density.toFixed(4)}）` +
        `，相差 ${(best.density / worst.density).toFixed(1)} 倍`
    );
  }

  console.log(`\n${line}\n死锁检测`);
  if (deadlock.deadlocked) {
    console.log(`  ⚠️  ${deadlock.reason}`);
    if (deadlock.nearest) {
      const p = planToTarget(deadlock.nearest, budget, estimateEarnRate({}));
      console.log(`  最近目标：${deadlock.nearest.spuName}（${deadlock.nearest.point} 分）`);
      console.log(`  ${p.note}`);
    }
  } else {
    console.log(`  ✓ ${deadlock.reason}`);
  }

  console.log(`\n${line}\n兑换方案（0/1 背包，每件单独成单）`);
  console.log(`  ${plan.note}`);
  for (const p of plan.plan) {
    console.log(`    · ${p.spuName}  ${p.point} 分 → ¥${p.cashValue}  密度 ${p.density.toFixed(4)}`);
  }
  if (plan.frontier?.length) {
    console.log(`  帕累托前沿 ${plan.frontier.length} 个非支配解：`);
    for (const f of plan.frontier) {
      console.log(`    · ${f.spuName}  ${f.point} 分 → ¥${f.cashValue}`);
    }
  }

  console.log(`\n${line}\n抽奖 vs 兑换`);
  if (lottery.available) {
    console.log(`  单抽 ${lottery.drawPoint} 分，最多 ${lottery.maxDraws} 次`);
    console.log(`  同额积分直接兑换可得约 ¥${lottery.redeemValue}`);
    if (lottery.note) console.log(`  ${lottery.note}`);
    if (lottery.verdict) console.log(`  ${lottery.verdict}`);
  } else {
    console.log(`  ${lottery.reason}`);
  }

  console.log(`\n${line}\n行动建议（按优先级）`);
  for (const a of actions) {
    console.log(`  [${a.priority}] ${a.title}`);
    console.log(`      ${a.detail}`);
    console.log(`      理由：${a.reason}`);
  }
  console.log(`\n${line}\n`);
}

main().catch((e) => {
  console.error("分析失败:", e.message);
  process.exit(1);
});
