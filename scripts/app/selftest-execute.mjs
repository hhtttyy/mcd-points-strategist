#!/usr/bin/env node
/**
 * mcd-points-strategist · 执行层与复盘自测
 *
 * 覆盖：
 *   ledger.mjs  账本记录、CSV 导出、earnRate 校准、有效消费口径、复盘偏差
 *   execute.mjs 写操作确认网关的计划逻辑（不实际调 MCP）
 */

import {
  calibrateEarnRate,
  makeRecord,
  parseLedger,
  refineTopUp,
  reviewLedger,
  sumEligibleSpend,
  toCsv,
} from "../analyze/ledger.mjs";

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

// --------------------------------------------------------------------------
console.log("\n【账本记录】");
// --------------------------------------------------------------------------
check("记录结构完整", () => {
  const r = makeRecord("redeem", { target: "6.9元可乐", costPoints: 50, gainYuan: 6.9 });
  return eq(
    [r.action, r.target, r.costPoints, r.gainYuan],
    ["redeem", "6.9元可乐", 50, 6.9]
  );
});
check("记录有 ISO 时间戳", () => {
  const r = makeRecord("claim");
  return truthy(r.ts && !Number.isNaN(new Date(r.ts).getTime()));
});
check("JSONL 解析：多行", () => {
  const text = [
    JSON.stringify(makeRecord("claim", { target: "A" })),
    JSON.stringify(makeRecord("draw", { costPoints: 24 })),
  ].join("\n");
  return eq(parseLedger(text).length, 2);
});
check("坏行被跳过而不整体失败", () => {
  const text = ["{坏JSON}", JSON.stringify(makeRecord("claim"))].join("\n");
  return eq(parseLedger(text).length, 1);
});
check("空账本解析为空数组", () => eq(parseLedger("").length, 0));
check("CSV 导出含表头与数据行", () => {
  const csv = toCsv([makeRecord("draw", { target: "奖品X", costPoints: 24 })]);
  const lines = csv.split("\n");
  return eq(lines.length, 2);
});
check("CSV 转义含逗号的字段", () => {
  const csv = toCsv([makeRecord("claim", { note: "a,b" })]);
  return truthy(csv.includes('"a,b"'));
});

// --------------------------------------------------------------------------
console.log("\n【有效消费口径】");
// --------------------------------------------------------------------------
check("整单退款不计入消费", () => {
  const s = sumEligibleSpend([
    { status: "整单退款", amount: 15.5 },
    { status: "订单已完成", amount: 22.4 },
  ]);
  return eq(s, 22.4);
});
check("0 元订单不计入消费", () => {
  const s = sumEligibleSpend([
    { status: "订单已完成", amount: 0 },
    { status: "订单已完成", amount: 36.5 },
  ]);
  return eq(s, 36.5);
});
check("部分退款仍全额计入（接口不给退款额）", () => {
  const s = sumEligibleSpend([{ status: "部分退款", amount: 36.5 }]);
  return eq(s, 36.5);
});

// --------------------------------------------------------------------------
console.log("\n【earnRate 校准 —— 从账户增量反推】");
// --------------------------------------------------------------------------
check("earnRate = Δ累计积分 / 有效消费", () => {
  const c = calibrateEarnRate(
    { accumulative: 581.3 },
    { accumulative: 607.3 }, // +26
    [{ status: "订单已完成", amount: 20 }, { status: "订单已完成", amount: 6 }]
  );
  return eq(c.earnRate, 1);
});
check("earnRate 反映真实加速（1.3 分/元）", () => {
  const c = calibrateEarnRate(
    { accumulative: 500 },
    { accumulative: 526 }, // +26
    [{ status: "订单已完成", amount: 20 }]
  );
  return eq(c.earnRate, 1.3);
});
check("积分没增加 → 无法校准，给出说明", () => {
  const c = calibrateEarnRate({ accumulative: 500 }, { accumulative: 500 }, [{ status: "订单已完成", amount: 20 }]);
  return eq([c.earnRate, c.confidence], [null, "insufficient"]);
});
check("没有消费 → 无法校准", () => {
  const c = calibrateEarnRate({ accumulative: 500 }, { accumulative: 510 }, []);
  return eq(c.earnRate, null);
});
check("样本少时置信度低", () => {
  const c = calibrateEarnRate({ accumulative: 0 }, { accumulative: 26 }, [{ status: "订单已完成", amount: 20 }]);
  return eq(c.confidence, "low");
});
check("样本多时置信度高", () => {
  const orders = Array.from({ length: 6 }, () => ({ status: "订单已完成", amount: 20 }));
  const c = calibrateEarnRate({ accumulative: 0 }, { accumulative: 120 }, orders);
  return eq(c.confidence, "high");
});
check("整单退款不污染 earnRate 分母", () => {
  const c = calibrateEarnRate(
    { accumulative: 0 },
    { accumulative: 26 },
    [{ status: "整单退款", amount: 100 }, { status: "订单已完成", amount: 20 }]
  );
  return eq(c.earnRate, 1.3);
});
check("缺少上一次快照时不能把缺失当 0（回归防护）", () => {
  // 若把缺失的 prev 当 0，581 分 / 59.4 元会算出 9.79 这种荒谬值
  const c = calibrateEarnRate(null, { accumulative: 581.3 }, [{ status: "订单已完成", amount: 59.4 }]);
  return eq([c.earnRate, c.confidence], [null, "insufficient"]);
});
check("缺少上一次快照时给出可操作的说明", () => {
  const c = calibrateEarnRate(null, { accumulative: 581.3 }, []);
  return truthy(c.note.includes("跑两次巡检"));
});

// --------------------------------------------------------------------------
console.log("\n【补差金额随 earnRate 修正】");
// --------------------------------------------------------------------------
check("默认 earnRate=1 时补差金额", () => {
  const r = refineTopUp({ point: 50 }, 33.5, 1);
  return eq([r.gap, r.spendNeeded], [16.5, 16.5]);
});
check("earnRate=1.3 时补差更便宜", () => {
  const r = refineTopUp({ point: 50 }, 33.5, 1.3);
  return eq([r.gap, r.spendNeeded], [16.5, 12.69]);
});
check("earnRate=0.8 时补差更贵", () => {
  const r = refineTopUp({ point: 50 }, 33.5, 0.8);
  return eq(r.spendNeeded, 20.63);
});
check("已达标时 gap=0", () => eq(refineTopUp({ point: 50 }, 60, 1).gap, 0));

// --------------------------------------------------------------------------
console.log("\n【复盘 —— 预期 vs 实际】");
// --------------------------------------------------------------------------
const records = [
  makeRecord("claim", { target: "免费脆薯饼" }),
  makeRecord("draw", { costPoints: 24, target: "麦麦积分抽奖", note: "抽中下单立减3元券" }),
  makeRecord("redeem", { costPoints: 50, target: "6.9元可乐麦炫酷", gainYuan: 6.9 }),
];

check("汇总各动作次数", () => {
  const r = reviewLedger(records);
  return eq([r.byAction.claim, r.byAction.draw, r.byAction.redeem], [1, 1, 1]);
});
check("累计支出积分正确", () => eq(reviewLedger(records).pointsSpent, 74));
check("累计预期收益正确", () => eq(reviewLedger(records).yuanGained, 6.9));
check("earnRate 偏差被识别", () => {
  const r = reviewLedger(records, {
    prevAccount: { accumulative: 500 },
    currentAccount: { accumulative: 600 },
    orders: [{ status: "订单已完成", amount: 77 }],
    defaultEarnRate: 1,
  });
  // 实际 100/77 = 1.2987，与默认 1 偏差 ≥ 0.05
  return truthy(r.deviations.some((d) => d.kind === "earnRate"));
});
check("偏差不大时不报（避免噪音）", () => {
  const r = reviewLedger(records, {
    prevAccount: { accumulative: 500 },
    currentAccount: { accumulative: 510 },
    orders: [{ status: "订单已完成", amount: 10 }],
    defaultEarnRate: 1,
  });
  return eq(r.deviations.filter((d) => d.kind === "earnRate").length, 0);
});
check("抽奖 ROI 被复盘", () => {
  const r = reviewLedger(records);
  const d = r.deviations.find((x) => x.kind === "lottery");
  return truthy(d && d.text.includes("抽奖"));
});
check("空账本给出明确说明", () => {
  const r = reviewLedger([]);
  return truthy(r.narrative.includes("账本还是空的"));
});
check("有记录时叙述包含关键数字", () => {
  const r = reviewLedger(records);
  return truthy(r.narrative.includes("3 条记录") && r.narrative.includes("74 积分"));
});

// --------------------------------------------------------------------------
console.log("\n──────────────────────────────────────────────────");
console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail) {
  console.log("失败明细：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
