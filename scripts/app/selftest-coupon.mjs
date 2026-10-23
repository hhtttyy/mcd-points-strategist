#!/usr/bin/env node
/**
 * mcd-points-strategist · 券引擎自测
 *
 * 覆盖 M2 的四个模块：
 *   coupon-model      5 类券分类、券面解析、叠加互斥、可用时段、凑单边际成本
 *   coupon-stack      组合计价、最优券组合、凑单陷阱检测
 *   coupon-audit      沉默成本、同款不同价、券体检
 *   coupon-schedule   点单机会预测、二分图最大匹配排程
 *
 * 用真实脱敏响应构造券数据，断言要覆盖边界情况。
 */

import {
  analyzeFiller,
  checkUsable,
  classify,
  computeUsableSlots,
  conflicts,
  findCompatibleSets,
  parseCouponTerms,
  parseWindow,
} from "../analyze/coupon-model.mjs";
import {
  detectFillerTraps,
  priceBasket,
  solveCouponPlan,
} from "../analyze/coupon-stack.mjs";
import {
  auditCoupons,
  computeSilentCost,
  findDuplicateTiers,
} from "../analyze/coupon-audit.mjs";
import {
  forecastOrders,
  scheduleCoupons,
} from "../analyze/coupon-schedule.mjs";

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
console.log("\n【5 类券分类】");
// --------------------------------------------------------------------------
check("「中薯条买一送一」→ bundle_price（同商品打包）", () =>
  eq(classify({ name: "中薯条买一送一" }).type, "bundle_price")
);
check("「买汉堡送香芋派」→ free_gift（不同商品）", () =>
  eq(classify({ name: "买汉堡送香芋派" }).type, "free_gift")
);
check("「满35减7」→ threshold", () => eq(classify({ name: "满35减7" }).type, "threshold"));
check("「立减5元」→ threshold", () => eq(classify({ name: "立减5元" }).type, "threshold"));
check("「6.9元可乐麦炫酷」→ item_price", () =>
  eq(classify({ name: "6.9元可乐麦炫酷" }).type, "item_price")
);
check("「麦辣鸡腿堡8折」→ percent", () =>
  eq(classify({ name: "麦辣鸡腿堡8折" }).type, "percent")
);
check("「1+1随心配」→ bundle_price", () =>
  eq(classify({ name: "1+1随心配" }).type, "bundle_price")
);
check("判不准 → threshold 且 confident=false", () => {
  const r = classify({ name: "某个看不懂的券" });
  return eq([r.type, r.confident], ["threshold", false]);
});

// --------------------------------------------------------------------------
console.log("\n【券面解析】");
// --------------------------------------------------------------------------
check("「满35减7」→ 门槛 35 面值 7", () => {
  const t = parseCouponTerms({ name: "满35减7" });
  return eq([t.threshold, t.faceValue], [35, 7]);
});
check("「立减5元」→ 面值 5", () => eq(parseCouponTerms({ name: "立减5元" }).faceValue, 5));
check("「6.9元可乐麦炫酷」→ 面值 6.9", () =>
  eq(parseCouponTerms({ name: "6.9元可乐麦炫酷" }).faceValue, 6.9)
);
check("「麦辣鸡腿堡8折」→ 折扣率 0.8", () =>
  eq(parseCouponTerms({ name: "麦辣鸡腿堡8折" }).discountPct, 0.8)
);
check("「王牌小食拼」→ 无数字，面值 0 且标 unknown", () => {
  const t = parseCouponTerms({ name: "王牌小食拼" });
  return eq([t.faceValue, t.unknown], [0, true]);
});

// --------------------------------------------------------------------------
console.log("\n【叠加与互斥 —— 保守策略】");
// --------------------------------------------------------------------------
const thresholdA = { name: "满35减7", type: "threshold", stackable: true, itemCodes: [] };
const thresholdB = { name: "满50减12", type: "threshold", stackable: true, itemCodes: [] };
const itemA = { name: "中薯条券", type: "item_price", stackable: true, itemCodes: ["9900012387"] };
const itemB = { name: "大薯条券", type: "item_price", stackable: true, itemCodes: ["9900012387"] };
const itemC = { name: "可乐券", type: "item_price", stackable: true, itemCodes: ["1088"] };

check("两张满减券可叠加", () => eq(conflicts(thresholdA, thresholdB), false));
check("同一商品的两张券互斥", () => eq(conflicts(itemA, itemB), true));
check("不同商品的券不互斥", () => eq(conflicts(itemA, itemC), false));
check("stackable=false 时一律互斥（保守默认）", () =>
  eq(conflicts({ ...thresholdA, stackable: false }, thresholdB), true)
);
check("可叠加组合：3 张券里找出 2 张不冲突的", () => {
  const sets = findCompatibleSets([itemA, itemB, itemC]);
  return sets.length > 0 && sets[0].length === 2 ? true : `实得 ${JSON.stringify(sets.map((s) => s.length))}`;
});

// --------------------------------------------------------------------------
console.log("\n【可用时段 —— 「还剩 4 天」≠「有 4 天能用」】");
// --------------------------------------------------------------------------
const weekdayCoupon = {
  name: "中薯条买一送一",
  // 10-14(周三) 到 10-19(周一)，跨过 10-17 周六与 10-18 周日
  expireAt: "2026-10-19T15:59:00Z",
  validFrom: null,
  weekdays: [0, 1, 2, 3, 4], // 周一~周五
  dayWindow: "10:30-23:59",
};
const singleDayCoupon = {
  name: "大脆鸡扒堡早餐两件套",
  // 10-22 是周四，与 weekdays [3] 一致
  expireAt: "2026-10-22T02:29:00Z",
  validFrom: null,
  weekdays: [3], // 仅周四
  dayWindow: "05:00-10:29",
};

check("工作日券：周末被算成不可用（剩余 6 天但只有 4 天能用）", () => {
  const s = computeUsableSlots(weekdayCoupon, { now: NOW });
  return eq([s.usableDays, s.unusableDays], [4, 2]);
});
check("单日券：不可用天数不应算进有效期（尚未生效 ≠ 不生效）", () => {
  const future = {
    ...singleDayCoupon,
    expireAt: "2026-10-22T02:29:00Z",
    validFrom: "2026-10-22T00:00:00Z",
  };
  const s = computeUsableSlots(future, { now: NOW });
  return eq(s.unusableDays, 0);
});
check("已过期的券 → expired=true", () => {
  const s = computeUsableSlots({ ...weekdayCoupon, expireAt: "2026-10-01T00:00:00Z" }, { now: NOW });
  return eq(s.expired, true);
});
check("没有截止日 → unknown，不当作无期限", () => {
  const s = computeUsableSlots({ name: "未领取券" }, { now: NOW });
  return eq([s.unknown, s.usableDays], [true, null]);
});
check("时段解析 05:00-10:29", () => {
  const w = parseWindow("05:00-10:29");
  return eq([w.contains(6), w.contains(18)], [true, false]);
});

// --------------------------------------------------------------------------
console.log("\n【可用性判定 —— 四个维度】");
// --------------------------------------------------------------------------
check("未领取的券 → 不可用", () =>
  eq(checkUsable({ name: "x", status: "可领取" }, {}).ok, false)
);
check("已过期的券 → 不可用", () =>
  eq(checkUsable({ name: "x", status: "已领取", expireAt: "2020-01-01T00:00:00Z" }, { at: NOW.toISOString() }).ok, false)
);
check("尚未生效的券 → 不可用", () =>
  eq(checkUsable({ name: "x", status: "已领取", validFrom: "2026-10-20T00:00:00Z" }, { at: NOW.toISOString() }).ok, false)
);
check("仅到店券 + 外送场景 → 不可用", () =>
  eq(checkUsable({ name: "x", status: "已领取", channel: ["pickup"] }, { channel: "delivery" }).ok, false)
);
check("时段外 → 不可用并说明原因", () => {
  const r = checkUsable({ name: "x", status: "已领取", dayWindow: "05:00-10:29" }, { hour: 18 });
  return eq([r.ok, r.reason.includes("时段")], [false, true]);
});
check("全部条件满足 → 可用", () =>
  eq(checkUsable({ name: "x", status: "已领取", channel: ["pickup", "delivery"], dayWindow: "05:00-23:59" }, { channel: "pickup", hour: 12 }).ok, true)
);

// --------------------------------------------------------------------------
console.log("\n【凑单边际成本】");
// --------------------------------------------------------------------------
check("小计已过门槛 → 不需凑单", () => {
  const r = analyzeFiller({ type: "threshold", threshold: 35, faceValue: 7 }, 40, []);
  return eq([r.needed, r.worthwhile], [0, true]);
});
check("加购 9 元换 7 元优惠 → 净多花 2 元，不划算", () => {
  const r = analyzeFiller({ type: "threshold", threshold: 35, faceValue: 7 }, 26, []);
  return eq([r.needed, r.marginalCost, r.worthwhile], [9, 2, false]);
});
check("加购 5 元换 7 元优惠 → 净省 2 元，划算", () => {
  const r = analyzeFiller({ type: "threshold", threshold: 35, faceValue: 7 }, 30, []);
  return eq([r.needed, r.marginalCost, r.worthwhile], [5, -2, true]);
});
check("无门槛券 → 不需凑单", () => {
  const r = analyzeFiller({ type: "item_price", threshold: 0, faceValue: 10 }, 10, []);
  return eq(r.needed, 0);
});

// --------------------------------------------------------------------------
console.log("\n【组合计价】");
// --------------------------------------------------------------------------
const basket = [
  { code: "9900001001", name: "巨无霸", price: 25 },
  { code: "9900012387", name: "中薯条", price: 14 },
  { code: "1088", name: "可乐", price: 9 },
];

check("不用券 → 原价 48", () => {
  const r = priceBasket(basket, []);
  return eq(r.total, 48);
});
check("单品券改价：中薯条 14 → 6.9", () => {
  const r = priceBasket(basket, [
    { name: "中薯条券", type: "item_price", stackable: true, itemCodes: ["9900012387"], faceValue: 6.9, overridePrice: 6.9 },
  ]);
  return eq(r.total, 40.9);
});
check("满减券：小计 48 ≥ 35 → 减 7", () => {
  const r = priceBasket(basket, [
    { name: "满35减7", type: "threshold", stackable: true, threshold: 35, faceValue: 7, itemCodes: [] },
  ]);
  return eq([r.subtotal, r.thresholdDiscount, r.total], [48, 7, 41]);
});
check("满减券门槛未达 → 不减", () => {
  const r = priceBasket([{ code: "a", name: "可乐", price: 9 }], [
    { name: "满35减7", type: "threshold", stackable: true, threshold: 35, faceValue: 7, itemCodes: [] },
  ]);
  return eq(r.thresholdDiscount, 0);
});
check("两张满减券不叠加，取更大的那个（保守）", () => {
  const r = priceBasket(basket, [
    { name: "满35减7", type: "threshold", stackable: true, threshold: 35, faceValue: 7, itemCodes: [] },
    { name: "满50减12", type: "threshold", stackable: true, threshold: 50, faceValue: 12, itemCodes: [] },
  ]);
  return eq(r.thresholdDiscount, 7);
});
check("外送配送费计入实付", () => {
  const r = priceBasket(basket, [], { deliveryFee: 6 });
  return eq(r.payable, 54);
});
check("折扣券：8 折作用于巨无霸", () => {
  const r = priceBasket(basket, [
    { name: "巨无霸8折", type: "percent", stackable: true, itemCodes: ["9900001001"], discountPct: 0.8, faceValue: 0 },
  ]);
  return eq(r.total, 43);
});
check("折扣与改价同时命中 → 取更便宜的，不叠乘（保守）", () => {
  const r = priceBasket([{ code: "x", name: "薯条", price: 14 }], [
    { name: "改价券", type: "item_price", stackable: true, itemCodes: ["x"], faceValue: 6.9, overridePrice: 6.9 },
    { name: "折扣券", type: "percent", stackable: true, itemCodes: ["x"], discountPct: 0.8, faceValue: 0 },
  ]);
  return eq(r.total, 6.9);
});
check("券的适用商品不在篮中 → 拒绝并说明原因", () => {
  const r = priceBasket(basket, [
    { name: "不适用券", type: "item_price", stackable: true, itemCodes: ["NOT_IN_BASKET"], faceValue: 5, overridePrice: 5 },
  ]);
  return eq([r.total, r.rejected.length], [48, 1]);
});

// --------------------------------------------------------------------------
console.log("\n【最优券组合求解】");
// --------------------------------------------------------------------------
check("无券可用 → 明确说没有净收益", () => {
  const r = solveCouponPlan(basket, [
    { name: "满99减50", type: "threshold", stackable: true, threshold: 99, faceValue: 50, itemCodes: [] },
  ]);
  return eq(r.plan, null);
});
check("有净收益时给出最优组合", () => {
  const r = solveCouponPlan(basket, [
    { name: "满35减7", type: "threshold", stackable: true, threshold: 35, faceValue: 7, itemCodes: [] },
  ]);
  return truthy(r.plan && r.plan.netSaving === 7);
});
check("需要凑单时，净收益要扣掉凑单成本", () => {
  const small = [{ code: "a", name: "可乐", price: 20 }];
  const r = solveCouponPlan(small, [
    { name: "满35减7", type: "threshold", stackable: true, threshold: 35, faceValue: 7, itemCodes: [] },
  ]);
  // 小计 20，门槛 35，需凑 15，但券只省 7 → 净收益为负
  return eq(r.plan, null);
});

// --------------------------------------------------------------------------
console.log("\n【凑单陷阱检测】");
// --------------------------------------------------------------------------
check("同商品仅券不同且用券更贵 → 报陷阱", () => {
  const plans = [
    { label: "直接下单", items: [{ code: "a", qty: 1 }], payable: 30, coupon: null },
    { label: "用券下单", items: [{ code: "a", qty: 1 }], payable: 35, coupon: "某券" },
  ];
  const w = detectFillerTraps(plans);
  return eq(w.length, 1);
});
check("用券更便宜 → 不报陷阱", () => {
  const plans = [
    { label: "直接下单", items: [{ code: "a", qty: 1 }], payable: 35, coupon: null },
    { label: "用券下单", items: [{ code: "a", qty: 1 }], payable: 30, coupon: "某券" },
  ];
  return eq(detectFillerTraps(plans).length, 0);
});
check("商品构成不同 → 不比较（避免噪音）", () => {
  const plans = [
    { label: "方案A", items: [{ code: "a", qty: 1 }], payable: 30, coupon: null },
    { label: "方案B", items: [{ code: "b", qty: 1 }], payable: 35, coupon: "某券" },
  ];
  return eq(detectFillerTraps(plans).length, 0);
});

// --------------------------------------------------------------------------
console.log("\n【沉默成本】");
// --------------------------------------------------------------------------
const riskCoupons = [
  { name: "已过期券", value: 10, status: "已领取", expireAt: "2026-10-01T00:00:00Z", weekdays: [], dayWindow: "" },
  { name: "今天到期券", value: 15, status: "已领取", expireAt: "2026-10-14T22:00:00Z", weekdays: [], dayWindow: "" },
  { name: "三天后到期券", value: 22.5, status: "已领取", expireAt: "2026-10-17T22:00:00Z", weekdays: [], dayWindow: "" },
  { name: "很久以后到期券", value: 50, status: "已领取", expireAt: "2026-12-01T22:00:00Z", weekdays: [], dayWindow: "" },
];
check("已过期 / 今天到期 / 即将过期 三类分开统计", () => {
  const r = computeSilentCost(riskCoupons, { now: NOW, expiringWithin: 7 });
  return eq([r.expiredCount, r.todayDueCount, r.upcomingCount], [1, 1, 1]);
});
check("风险面值合计正确", () => {
  const r = computeSilentCost(riskCoupons, { now: NOW, expiringWithin: 7 });
  return eq(r.atRiskValue, 47.5);
});
check("很久以后到期的券不计入风险", () => {
  const r = computeSilentCost(riskCoupons, { now: NOW, expiringWithin: 7 });
  return eq(r.totalValue, 97.5);
});
check("券面价值无法确定的券要单独说明", () => {
  const r = computeSilentCost(
    [...riskCoupons, { name: "价值未知券", value: 0, status: "已领取", expireAt: "2026-10-16T22:00:00Z" }],
    { now: NOW, expiringWithin: 7 }
  );
  return truthy(r.unknownCount >= 1 && r.narrative.includes("未计入面值"));
});
check("没有券时给出明确结论", () => {
  const r = computeSilentCost([], { now: NOW });
  return truthy(r.narrative.includes("没有"));
});

// --------------------------------------------------------------------------
console.log("\n【同款不同价】");
// --------------------------------------------------------------------------
check("同名不同面额 → 指出该换便宜的", () => {
  const found = findDuplicateTiers([
    { name: "10.9元指定小食任选", value: 10.9, id: "a" },
    { name: "10.9元指定小食任选", value: 5.9, id: "b" },
  ]);
  return eq([found.length, found[0].waste], [1, 5]);
});
check("同款同价 → 不报", () =>
  eq(findDuplicateTiers([
    { name: "a", value: 10, id: "1" },
    { name: "a", value: 10, id: "2" },
  ]).length, 0)
);

// --------------------------------------------------------------------------
console.log("\n【券体检】");
// --------------------------------------------------------------------------
check("体检输出包含四个维度", () => {
  const r = auditCoupons(riskCoupons, { now: NOW, expiringWithin: 7 });
  return eq(
    [r.silent !== undefined, r.unusable !== undefined, r.unclaimed !== undefined, r.duplicates !== undefined],
    [true, true, true, true]
  );
});
check("未领取的券被单独列出", () => {
  const r = auditCoupons([{ name: "可领券", value: 0, status: "可领取" }], { now: NOW });
  return eq(r.unclaimed.length, 1);
});
check("体检结论是一句话", () => {
  const r = auditCoupons(riskCoupons, { now: NOW });
  return truthy(typeof r.narrative === "string" && r.narrative.length > 5);
});

// --------------------------------------------------------------------------
console.log("\n【点单机会预测】");
// --------------------------------------------------------------------------
check("无历史订单 → 保守按每周一次", () => {
  const r = forecastOrders([], { now: NOW });
  return eq(r.cadenceDays, 7);
});
check("有历史订单 → 按节奏推算未来几次", () => {
  const orders = [
    { createdAt: "2026-10-10 12:00:00" },
    { createdAt: "2026-10-03 12:00:00" },
    { createdAt: "2026-09-26 12:00:00" },
  ];
  const r = forecastOrders(orders, { now: NOW, horizonDays: 30 });
  return truthy(r.cadenceDays === 7 && r.orders.length > 0);
});
check("推算出的订单带星期信息（供星期限制匹配）", () => {
  const orders = [{ createdAt: "2026-10-10 12:00:00" }];
  const r = forecastOrders(orders, { now: NOW, horizonDays: 30 });
  return truthy(r.orders[0] && typeof r.orders[0].dow === "number");
});

// --------------------------------------------------------------------------
console.log("\n【用券排程 —— 二分图最大匹配】");
// --------------------------------------------------------------------------
const schedOrders = [
  { index: 1, date: "2026-10-15", dow: 3, dowText: "周四", hour: 12 },
  { index: 2, date: "2026-10-17", dow: 5, dowText: "周六", hour: 12 },
  { index: 3, date: "2026-10-20", dow: 1, dowText: "周二", hour: 12 },
];
check("工作日券排到工作日的订单上，不排到周六", () => {
  const r = scheduleCoupons(
    [{ name: "工作日券", value: 10, status: "已领取", expireAt: "2026-10-21T00:00:00Z", weekdays: [0, 1, 2, 3, 4], dayWindow: "" }],
    schedOrders,
    { now: NOW }
  );
  return eq(r.assignments[0]?.orderIndex, 1);
});
check("单日券只能排到那一天", () => {
  const r = scheduleCoupons(
    [{ name: "单日券", value: 9.9, status: "已领取", expireAt: "2026-10-15T23:59:00Z", weekdays: [3], dayWindow: "" }],
    schedOrders,
    { now: NOW }
  );
  return eq(r.assignments[0]?.orderIndex, 1);
});
check("券多订单少时，多出来的券标为排不进去并说明原因", () => {
  const r = scheduleCoupons(
    [
      { name: "券A", value: 10, status: "已领取", expireAt: "2026-10-21T00:00:00Z", weekdays: [], dayWindow: "" },
      { name: "券B", value: 10, status: "已领取", expireAt: "2026-10-21T00:00:00Z", weekdays: [], dayWindow: "" },
      { name: "券C", value: 10, status: "已领取", expireAt: "2026-10-21T00:00:00Z", weekdays: [], dayWindow: "" },
    ],
    [schedOrders[0]],
    { now: NOW }
  );
  return eq([r.scheduledCount, r.unassignedCount], [1, 2]);
});
check("可用机会少的券优先占位（不是谁先过期先用谁）", () => {
  // 券1 只能用周四；券2 任何时候都能用。应该让券1 占用周四那一单，
  // 把通用的券2 留到后面 —— 这样才能多排出去一张
  const r = scheduleCoupons(
    [
      { name: "只能周四", value: 10, status: "已领取", expireAt: "2026-10-16T00:00:00Z", weekdays: [3], dayWindow: "" },
      { name: "通用券", value: 10, status: "已领取", expireAt: "2026-10-21T00:00:00Z", weekdays: [], dayWindow: "" },
    ],
    schedOrders,
    { now: NOW }
  );
  // 两张都排得进去 = 匹配最优
  return eq(r.scheduledCount, 2);
});
check("排程覆盖率与净价值被汇报", () => {
  const r = scheduleCoupons(
    [{ name: "券A", value: 13.5, status: "已领取", expireAt: "2026-10-21T00:00:00Z", weekdays: [], dayWindow: "" }],
    schedOrders,
    { now: NOW }
  );
  return eq([r.scheduledValue, r.coverageRate], [13.5, 1]);
});
check("没有券时返回空排程", () => {
  const r = scheduleCoupons([], schedOrders, { now: NOW });
  return eq(r.scheduledCount, 0);
});
check("未领取的券不参与排程，单独列为「先领」", () => {
  const r = scheduleCoupons(
    [{ name: "未领券", value: 5, status: "可领取", expireAt: null, weekdays: [], dayWindow: "" }],
    schedOrders,
    { now: NOW }
  );
  return eq([r.scheduledCount, r.unclaimed.length], [0, 1]);
});
check("已领取 + 未领取混合时，只排已领取的", () => {
  const r = scheduleCoupons(
    [
      { name: "已领券", value: 10, status: "已领取", expireAt: "2026-10-21T00:00:00Z", weekdays: [], dayWindow: "" },
      { name: "未领券", value: 5, status: "可领取", expireAt: null, weekdays: [], dayWindow: "" },
    ],
    schedOrders,
    { now: NOW }
  );
  return eq([r.scheduledCount, r.unclaimed.length], [1, 1]);
});

// --------------------------------------------------------------------------
console.log("\n──────────────────────────────────────────────────");
console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail) {
  console.log("失败明细：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
