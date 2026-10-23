#!/usr/bin/env node
/**
 * mcd-points-strategist · 巡检与联合决策自测
 *
 * 覆盖：
 *   diff.mjs        昨日今日增量：新活动/新券/新订单/核销/临期/积分变动
 *   asset-plan.mjs  积分影子价格、资源折算、联合决策动作排序
 *   render.mjs      看板渲染的长度约束与关键信息完整性
 */

import { diffSnapshots } from "../analyze/diff.mjs";
import {
  computeShadowPrice,
  planAssetAllocation,
  pointsToYuan,
  valueAllResources,
  yuanToPoints,
} from "../analyze/asset-plan.mjs";
import { renderDashboard, renderPatrol } from "./render.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      failures.push(`${name} → ${r}`);
      console.log(`  ✗ ${name}  ${r}`);
    }
  } catch (e) {
    fail++;
    failures.push(`${name} → 异常: ${e.message}`);
    console.log(`  ✗ ${name}  异常: ${e.message}`);
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
    ? true
    : `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`;
}
function truthy(v) {
  return v ? true : `实得 ${JSON.stringify(v)}`;
}

const NOW = new Date("2026-10-14T12:00:00Z");

// --------------------------------------------------------------------------
console.log("\n【积分影子价格 —— 让积分和券能比大小】");
// --------------------------------------------------------------------------
const mall = [
  { spuId: 1, name: "6.9元可乐麦炫酷", points: 50, faceValue: 6.9, status: "live" },
  { spuId: 2, name: "18.8元2份麦辣鸡翅", points: 200, faceValue: 18.8, status: "live" },
  { spuId: 3, name: "21.9元巨无霸可乐组合", points: 800, faceValue: 21.9, status: "live" },
  { spuId: 4, name: "已下架档位", points: 100, faceValue: 20, status: "expired" },
];

check("影子价格 = 可达最优档的密度", () => {
  const s = computeShadowPrice(mall, { available: 400 });
  // 400 分能达到 50 分档(0.138) 和 200 分档(0.094)，最优是 50 分档
  return eq(s.price, 0.138);
});
check("已下架标的不参与影子价格计算", () => {
  const s = computeShadowPrice(mall, { available: 400 });
  return truthy(s.best && s.best.name === "6.9元可乐麦炫酷");
});
check("够不到任何档时退化为全站最优，但标记 reachableOnly=false", () => {
  const s = computeShadowPrice(mall, { available: 10 });
  return eq([s.reachableOnly, s.price], [false, 0.138]);
});
check("没有在售标的 → 影子价格为 0 且给出说明", () => {
  const s = computeShadowPrice([], { available: 100 });
  return eq([s.price, truthy(s.note)], [0, true]);
});
check("积分 → 元换算", () => eq(pointsToYuan(800, 0.138), 110.4));
check("元 → 积分换算", () => eq(yuanToPoints(13.5, 0.138), 97.8));
check("影子价格为 0 时换算返回 null（不编造）", () => eq(yuanToPoints(10, 0), null));

// --------------------------------------------------------------------------
console.log("\n【资源统一折算】");
// --------------------------------------------------------------------------
const couponSet = [
  { name: "中薯条买一送一", value: 13.5, source: "my", status: "已领取", expireAt: "2026-10-20T15:59:00Z" },
  { name: "免费脆薯饼", value: 0, source: "mcd-savers", status: "可领取" },
];

check("券折算成等值积分", () => {
  const v = valueAllResources({ account: { available: 400 }, coupons: couponSet, mall });
  return eq(v.coupons[0].pointsWorth, 97.8);
});
check("券价值占可用积分的比例", () => {
  const v = valueAllResources({ account: { available: 400 }, coupons: couponSet, mall });
  return eq(v.coupons[0].shareOfBalance, 24.5);
});
check("积分资产折算成金额", () => {
  const v = valueAllResources({ account: { available: 400, expiringThisMonth: 50 }, coupons: couponSet, mall });
  return eq(v.points.yuanWorth, 55.2);
});
check("临期积分折算成金额", () => {
  const v = valueAllResources({ account: { available: 400, expiringThisMonth: 50 }, coupons: couponSet, mall });
  return eq(v.points.expiringThisMonthYuan, 6.9);
});
check("给出 1 积分 ≈ ¥X 的表述", () => {
  const v = valueAllResources({ account: { available: 400 }, coupons: couponSet, mall });
  return truthy(v.note.includes("1 积分"));
});

// --------------------------------------------------------------------------
console.log("\n【联合决策 —— 积分 × 券一起排】");
// --------------------------------------------------------------------------
const fullInput = {
  account: {
    available: 400, accumulative: 763, used: 188, expired: 17,
    expiringThisMonth: 50, expiringNextMonth: 0, currency: "麦享会积分",
  },
  coupons: [
    { name: "中薯条买一送一", value: 13.5, source: "my", status: "已领取", expireAt: "2026-10-16T15:59:00Z", weekdays: [], dayWindow: "" },
    { name: "免费脆薯饼", value: 0, source: "mcd-savers", status: "可领取" },
  ],
  mall,
  lottery: { name: "麦麦积分抽奖", drawPoint: 24, drawType: "消耗积分抽奖", status: "进行中" },
  campaigns: [{ date: "2026-10-14", phase: "今日", titles: ["麦当劳 X PEACEMINUSONE"], highlights: "" }],
  orders: [],
};

check("领券排第一（零成本且不领就消失）", () => {
  const p = planAssetAllocation(fullInput, { now: NOW });
  return eq(p.actions[0].type, "claim_coupon");
});
check("临期积分被列为高优先级", () => {
  const p = planAssetAllocation(fullInput, { now: NOW });
  const a = p.actions.find((x) => x.type === "points_expiring");
  return eq([truthy(a), a?.priority], [true, 2]);
});
check("临期券被单列并换算成积分", () => {
  const p = planAssetAllocation(fullInput, { now: NOW });
  const a = p.actions.find((x) => x.type === "coupon_expiring");
  return eq([truthy(a), a?.gain?.points], [true, 97.8]);
});
check("抽奖动作带上积分成本", () => {
  const p = planAssetAllocation(fullInput, { now: NOW });
  const a = p.actions.find((x) => x.type === "draw");
  return eq(a?.cost?.points, 24 * Math.floor(400 / 24));
});
check("兑换动作指向可达最优档", () => {
  const p = planAssetAllocation(fullInput, { now: NOW });
  const a = p.actions.find((x) => x.type === "redeem");
  return eq(a?.title, "兑换「6.9元可乐麦炫酷」");
});
check("死锁时给补差方案而非硬推兑换", () => {
  const p = planAssetAllocation({ ...fullInput, account: { ...fullInput.account, available: 10 } }, { now: NOW });
  const a = p.actions.find((x) => x.type === "deadlock");
  return eq([truthy(a), a?.gap], [true, 40]);
});
check("活动只做提醒，不参与金额计算", () => {
  const p = planAssetAllocation(fullInput, { now: NOW });
  const a = p.actions.find((x) => x.type === "campaign");
  return eq([truthy(a), a?.gain?.yuan], [true, null]);
});
check("动作按优先级排序", () => {
  const p = planAssetAllocation(fullInput, { now: NOW });
  const ps = p.actions.map((a) => a.priority);
  return eq(ps, [...ps].sort((a, b) => a - b));
});

// --------------------------------------------------------------------------
console.log("\n【快照增量 —— 每天检测到什么变化】");
// --------------------------------------------------------------------------
const prevSnap = {
  generatedAt: "2026-10-13T09:00:00Z",
  account: { available: 376.3, accumulative: 581.3, used: 188, expired: 17, expiringThisMonth: 0, expiringNextMonth: 0 },
  campaigns: [{ date: "2026-10-13", phase: "今日", titles: ["旧活动"], highlights: "" }],
  coupons: [
    { name: "中薯条买一送一", value: 13.5, source: "my", status: "已领取", expireAt: "2026-10-16T15:59:00Z" },
    { name: "已用掉的券", value: 9.9, source: "my", status: "已领取", expireAt: "2026-10-20T02:29:00Z" },
  ],
  mall: [{ spuId: 1, name: "6.9元可乐麦炫酷", points: 50, faceValue: 6.9, status: "live" }],
  lottery: { name: "麦麦积分抽奖", drawPoint: 24, status: "进行中", prizes: [{ name: "A" }] },
  orders: [{ orderId: "OLD-1", storeName: "旧门店", amount: 20 }],
};

const currSnap = {
  generatedAt: "2026-10-14T09:00:00Z",
  account: { available: 402.3, accumulative: 607.3, used: 188, expired: 17, expiringThisMonth: 50, expiringNextMonth: 0 },
  campaigns: [
    { date: "2026-10-13", phase: "今日", titles: ["旧活动"], highlights: "" },
    { date: "2026-10-14", phase: "今日", titles: ["新活动"], highlights: "" },
  ],
  coupons: [
    { name: "中薯条买一送一", value: 13.5, source: "my", status: "已领取", expireAt: "2026-10-16T15:59:00Z" },
    { name: "新券", value: 7.5, source: "mcd-savers", status: "可领取" },
  ],
  mall: [
    { spuId: 1, name: "6.9元可乐麦炫酷", points: 50, faceValue: 6.9, status: "live" },
    { spuId: 2, name: "新标的", points: 200, faceValue: 18.8, status: "live" },
    { spuId: 3, name: "下架了", points: 100, faceValue: 20, status: "expired" },
  ],
  lottery: { name: "麦麦积分抽奖", drawPoint: 30, status: "进行中", prizes: [{ name: "A" }, { name: "B" }] },
  orders: [
    { orderId: "OLD-1", storeName: "旧门店", amount: 20 },
    { orderId: "NEW-1", storeName: "六道口店", amount: 36.5 },
  ],
};

check("首次运行标记 isFirstRun", () => eq(diffSnapshots(null, currSnap, { now: NOW }).isFirstRun, true));
check("检测到新活动", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq(d.newCampaigns.length, 1);
});
check("检测到新券", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq(d.newCoupons.length, 1);
});
check("检测到新增兑换标的", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq(d.newMallItems.length, 2);
});
check("检测到你下了一单（orderId 识别）", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq(d.newOrders.length, 1);
});
check("检测到券被核销（还在有效期却消失）", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq(d.usedCoupons.length, 1);
});
check("积分变动被算出", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq(d.account.availableDelta, 26);
});
check("临期积分被报出", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq(d.expiringPoints.thisMonth, 50);
});
check("临期券被报出", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq(d.expiringCoupons.length, 1);
});
check("抽奖变化被检测（消耗从 24 变 30 + 新奖品）", () => {
  const d = diffSnapshots(prevSnap, currSnap, { now: NOW });
  return eq([d.lottery.changed, d.lottery.changes.length], [true, 2]);
});
check("无变化时摘要说「与上次一致」", () => {
  const d = diffSnapshots(prevSnap, prevSnap, { now: NOW });
  return eq(d.summary.headline, "与上次一致");
});

// --------------------------------------------------------------------------
console.log("\n【看板渲染】");
// --------------------------------------------------------------------------
check("看板包含四个区块", () => {
  const out = renderDashboard({ snapshot: currSnap, diff: diffSnapshots(prevSnap, currSnap, { now: NOW }) }, { now: NOW });
  return eq(
    [out.includes("积分"), out.includes("券包"), out.includes("今日活动"), out.includes("待办")],
    [true, true, true, true]
  );
});
check("看板长度控制在 40 行内（手机可读）", () => {
  const out = renderDashboard({ snapshot: currSnap, diff: diffSnapshots(prevSnap, currSnap, { now: NOW }) }, { now: NOW });
  const lines = out.split("\n").length;
  return lines <= 40 ? true : `实得 ${lines} 行`;
});
check("变化被放在看板顶部", () => {
  const out = renderDashboard({ snapshot: currSnap, diff: diffSnapshots(prevSnap, currSnap, { now: NOW }) }, { now: NOW });
  return out.indexOf("🧾") > 0 && out.indexOf("🧾") < out.indexOf("💰");
});
check("待办里写操作标注 [执行]", () => {
  const out = renderDashboard({ snapshot: currSnap, diff: diffSnapshots(prevSnap, currSnap, { now: NOW }) }, { now: NOW });
  return out.includes("[执行]");
});
check("首次运行不显示空的变化区", () => {
  const out = renderDashboard({ snapshot: currSnap, diff: diffSnapshots(null, currSnap, { now: NOW }) }, { now: NOW });
  return !out.includes("🧾");
});
check("巡检报告包含变化明细", () => {
  const out = renderPatrol({ snapshot: currSnap, diff: diffSnapshots(prevSnap, currSnap, { now: NOW }), store: "1990622" });
  return eq([out.includes("🔍 与上次的变化"), out.includes("新活动")], [true, true]);
});
check("巡检报告列出三路券源", () => {
  const out = renderPatrol({ snapshot: currSnap, diff: diffSnapshots(prevSnap, currSnap, { now: NOW }) });
  return eq([out.includes("麦麦省可领"), out.includes("卡包持有")], [true, true]);
});

// --------------------------------------------------------------------------
console.log("\n【闭环 —— earnRate 回校影响决策】");
// --------------------------------------------------------------------------
check("看板显示实测 earnRate", () => {
  const out = renderDashboard(
    {
      snapshot: currSnap,
      diff: diffSnapshots(prevSnap, currSnap, { now: NOW }),
      prevAccount: { accumulative: 581.3 },
    },
    { now: NOW }
  );
  return truthy(out.includes("earnRate 实测"));
});
check("无上一次快照时不显示 earnRate（不编造）", () => {
  const out = renderDashboard(
    { snapshot: currSnap, diff: diffSnapshots(prevSnap, currSnap, { now: NOW }), prevAccount: null },
    { now: NOW }
  );
  return !out.includes("earnRate 实测");
});
check("死锁时用实测 earnRate 算补差金额", () => {
  const deadInput = {
    ...fullInput,
    account: { ...fullInput.account, available: 10 },
  };
  const withDefault = planAssetAllocation(deadInput, { now: NOW });
  const withCalib = planAssetAllocation(deadInput, { now: NOW, earnRate: 2 });
  const a1 = withDefault.actions.find((x) => x.type === "deadlock");
  const a2 = withCalib.actions.find((x) => x.type === "deadlock");
  // earnRate=2 时同样缺口花的钱更少
  return truthy(a2.spendNeeded < a1.spendNeeded);
});
check("未校准时明确标注用的是默认值", () => {
  const p = planAssetAllocation(
    { ...fullInput, account: { ...fullInput.account, available: 10 } },
    { now: NOW }
  );
  const a = p.actions.find((x) => x.type === "deadlock");
  return eq(a.earnRateCalibrated, false);
});
check("校准后标注为已校准", () => {
  const p = planAssetAllocation(
    { ...fullInput, account: { ...fullInput.account, available: 10 } },
    { now: NOW, earnRate: 1.3 }
  );
  const a = p.actions.find((x) => x.type === "deadlock");
  return eq(a.earnRateCalibrated, true);
});

// --------------------------------------------------------------------------
console.log("\n──────────────────────────────────────────────────");
console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail) {
  console.log("失败明细：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
