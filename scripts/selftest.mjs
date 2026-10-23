#!/usr/bin/env node
/**
 * mcd-points-strategist · 自测套件
 *
 * 运行：node scripts/selftest.mjs
 * 退出码 0 表示全部通过。
 */

import {
  computeDensity,
  rankByDensity,
  detectDelistedTrap,
  detectDeadlock,
  solveRedeemPlan,
  scoreHealth,
  buildParetoFrontier,
  planToTarget,
  buildActionPlan,
  POINTS_REDEEM_SHOP_ID,
} from "./points-engine.mjs";

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-10-23T12:00:00");

// ---------- 构造测试数据 ----------
const live = (spuId, spuName, point, faceValue, extra = {}) => ({
  spuId,
  spuName,
  point,
  faceValue,
  catName: "到店专用",
  shopId: POINTS_REDEEM_SHOP_ID,
  status: "live",
  downTime: "2027-12-31 23:59:59",
  ...extra,
});

const expired = (spuId, spuName, point, faceValue) => ({
  spuId,
  spuName,
  point,
  faceValue,
  catName: "到店专用",
  shopId: POINTS_REDEEM_SHOP_ID,
  status: "expired",
  downTime: "2026-01-10 17:00:00",
});

const MALL = [
  live(1, "6.9元可乐麦炫酷", 50, 6.9),
  live(2, "6.9元香芋派/菠萝派任选", 50, 6.9),
  live(3, "10.9元指定小食任选", 100, 10.9),
  live(4, "17.9元板烧可乐组合", 500, 17.9),
  live(5, "21.9元巨无霸可乐组合", 800, 21.9),
  expired(6, "已结束活动", 1, 0),
  { spuId: 7, spuName: "派对现金购买", point: 0, faceValue: 50, shopId: 5, status: "live" },
];

console.log("\nmcd-points-strategist · 自测\n" + "─".repeat(50));

// ---------- 密度计算 ----------
console.log("\n[密度与过滤]");
const d1 = computeDensity(MALL[0], NOW);
check("面值密度计算正确 (6.9元/50分 = 0.138)", Math.abs(d1.density - 0.138) < 1e-9, `得到 ${d1.density}`);
check("point=0 的现金类标的不参与排名", computeDensity(MALL[6], NOW) === null);
check("已下架标的被剔除", computeDensity(MALL[5], NOW) === null);

const ranked = rankByDensity(MALL, NOW);
check("密度降序排列", ranked.length === 5 && ranked[0].density >= ranked[4].density);
check("最优档是 50 分的 6.9 元", ranked[0].point === 50 && ranked[0].density === 0.138);

// ---------- 边际收益率递减 ----------
console.log("\n[边际收益率递减]");
const best = ranked[0];
const worst = ranked[ranked.length - 1];
check(
  "最优档密度约为最差档的 5 倍",
  Math.abs(best.density / worst.density - 5) < 0.1,
  `得到 ${(best.density / worst.density).toFixed(3)}`
);

// ---------- 下架陷阱 ----------
console.log("\n[下架陷阱检测]");
const trap = detectDelistedTrap(MALL, NOW);
check("识别出 1 个已下架积分标的", trap.expiredWithPoints === 1, `得到 ${trap.expiredWithPoints}`);
check("统计在售可兑换数为 5", trap.liveRedeemable === 5, `得到 ${trap.liveRedeemable}`);
check("总数统计为 7", trap.total === 7, `得到 ${trap.total}`);

// ---------- 死锁检测 ----------
console.log("\n[门槛-余额错配死锁]");
const account33 = {
  availablePoint: 33.5,
  accumulativePoint: 763,
  expiredPoint: 729.5,
  usedPoint: 0,
  currentMouthExpirePoint: 0,
};
const dl = detectDeadlock(account33, MALL);
check("33.5 分被判定为死锁", dl.deadlocked === true);
check("给出最近可达目标", dl.nearest && dl.nearest.point === 50, JSON.stringify(dl.nearest?.point));
check("补差计算为 16.5 分", Math.abs(dl.nearest.gap - 16.5) < 1e-9, `得到 ${dl.nearest.gap}`);

const account500 = { ...account33, availablePoint: 500 };
const dl2 = detectDeadlock(account500, MALL);
check("500 分不再死锁", dl2.deadlocked === false, dl2.reason);

// ---------- 背包求解 ----------
console.log("\n[0/1 背包求解]");
const plan50 = solveRedeemPlan(MALL, 50, { now: NOW });
check("50 分恰好兑换 1 件 6.9 元", plan50.plan.length === 1 && plan50.totalCash === 6.9, JSON.stringify(plan50.plan.map(p=>p.spuName)));
check("剩余积分为 0", plan50.leftover === 0);

const plan100 = solveRedeemPlan(MALL, 100, { now: NOW });
// 两件 6.9 元（100 分 → 13.8 元）严格优于一件 10.9 元（100 分 → 10.9 元）
check("100 分方案选两件 6.9 元而非一件 10.9 元", plan100.totalCash === 13.8, `得到 ${plan100.totalCash}`);
check("100 分方案确实换了 2 件", plan100.plan.length === 2, `得到 ${plan100.plan.length}`);

const plan150 = solveRedeemPlan(MALL, 150, { now: NOW });
check("150 分方案面值 17.8（一件 6.9 + 一件 10.9）", plan150.totalCash === 17.8, `得到 ${plan150.totalCash}`);

const plan800 = solveRedeemPlan(MALL, 800, { now: NOW });
check("800 分可兑换多件且面值最优", plan800.totalCash >= 17.9 + 10.9, `得到 ${plan800.totalCash}`);
check("方案总积分不超过预算", plan800.totalPoint <= 800);

const plan30 = solveRedeemPlan(MALL, 30, { now: NOW });
check("30 分无法兑换任何标的", plan30.plan.length === 0);
check("并给出明确原因", /不足以兑换/.test(plan30.note), plan30.note);

// ---------- 帕累托前沿 ----------
console.log("\n[帕累托前沿]");
const frontier = buildParetoFrontier(
  MALL.filter((m) => m.shopId === POINTS_REDEEM_SHOP_ID && m.status === "live"),
  800
);
let nonDominated = true;
for (let i = 0; i < frontier.length; i++) {
  for (let j = 0; j < frontier.length; j++) {
    if (i === j) continue;
    if (frontier[j].point <= frontier[i].point && frontier[j].cashValue >= frontier[i].cashValue &&
        (frontier[j].point < frontier[i].point || frontier[j].cashValue > frontier[i].cashValue)) {
      nonDominated = false;
    }
  }
}
check("前沿中无被支配解", nonDominated, JSON.stringify(frontier.map(f=>[f.point,f.cashValue])));

// ---------- 健康度评分 ----------
console.log("\n[健康度评分]");
const health = scoreHealth(account33, MALL);
check("低存活率导致低分 (12/100 危险)", health.score === 12 && health.grade === "危险", `得到 ${health.score} ${health.grade}`);
check("衰减率计算正确 (729.5/763 ≈ 95.6%)", Math.abs(health.decayRate - 0.9561) < 0.001, `得到 ${health.decayRate}`);
check("健康账户得分更高", scoreHealth({ ...account33, availablePoint: 700, accumulativePoint: 763 }, MALL).score > health.score);

// ---------- 补差规划 ----------
console.log("\n[补差规划]");
const tp = planToTarget({ point: 50 }, 33.5, 1);
check("补差金额 = 16.5 元", Math.abs(tp.spendNeeded - 16.5) < 1e-9, `得到 ${tp.spendNeeded}`);
const tp0 = planToTarget({ point: 50 }, 50, 1);
check("已达标时 spendNeeded 为 0", tp0.spendNeeded === 0);
check("已达标时提示立即兑换", /立即兑换/.test(tp0.note));

// ---------- 行动建议 ----------
console.log("\n[行动建议排序]");
const actions = buildActionPlan({
  account: account33,
  mall: MALL,
  lottery: { drawPoint: 24, activityName: "麦麦积分抽奖", drawTypeText: "消耗积分抽奖" },
  coupons: [{ title: "免费脆薯饼" }, { title: "11.9元麦辣鸡腿堡" }],
});
check("生成 4 项行动建议", actions.length === 4, `得到 ${actions.length}`);
check("零成本领券优先级最高", actions[0].type === "claim_coupon", actions[0].type);
check("下架陷阱被纳入建议", actions.some((a) => a.type === "avoid_trap"));
check("补差建议已生成", actions.some((a) => a.type === "top_up"));
check("抽奖建议已生成", actions.some((a) => a.type === "draw"));
check("无兑换建议（余额不足）", !actions.some((a) => a.type === "redeem"));

// ---------- 边界 ----------
console.log("\n[边界情况]");
check("空商城不崩溃", rankByDensity([], NOW).length === 0);
check("零预算不崩溃", solveRedeemPlan(MALL, 0, { now: NOW }).plan.length === 0);
check("负预算不崩溃", solveRedeemPlan(MALL, -10, { now: NOW }).plan.length === 0);
check("空账户健康度不崩溃", typeof scoreHealth({}, []).score === "number");

console.log("\n" + "─".repeat(50));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed === 0 ? 0 : 1);
