#!/usr/bin/env node
/**
 * mcd-points-strategist · 券实际价值测算 + 门店促销规则 回归测试
 *
 * 覆盖两个 2026-10-23 实测发现的能力：
 *   1. 券的实际优惠额（靠 calculate-price 两次对比）
 *   2. 门店促销规则（结构化，可参与计算，且带渠道约束）
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mergeCoupons, collectMyCoupons, collectStoreCoupons, collectPromotions } from "../collect/collectors.mjs";
import { collectMenuItems } from "../collect/menu.mjs";
import { comparePricings, extractPricing, summarizeCouponValues } from "../analyze/coupon-value.mjs";
import { analyzePromotionRules, bestPromotionFor } from "../analyze/promotion-rules.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const LIVE = resolve(ROOT, "fixtures/live");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      failures.push(`${name} → ${r === false ? "断言为 false" : JSON.stringify(r)}`);
      console.log(`  ✗ ${name}  ${r === false ? "" : JSON.stringify(r)}`);
    }
  } catch (e) {
    fail++;
    failures.push(`${name} → 抛出异常：${e.message}`);
    console.log(`  ✗ ${name}  抛出异常：${e.message}`);
  }
}

function eq(a, b) {
  // 数组逐项比较（`===` 对数组永远 false，会造成假失败）
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return `第 ${i} 项：期望 ${JSON.stringify(b[i])}，实得 ${JSON.stringify(a[i])}`;
    }
    return true;
  }
  return a === b ? true : `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`;
}

function load(name) {
  const p = resolve(LIVE, `${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

const NOW = new Date("2026-10-23T08:00:00Z");

// ---------------------------------------------------------------------------
console.log("【三路合并 · 逐字段取并集】");
// ---------------------------------------------------------------------------

const myRaw = load("my_coupons");
const storeRaw = load("store_coupons");

if (myRaw && storeRaw) {
  const my = collectMyCoupons(myRaw, { now: NOW });
  const store = collectStoreCoupons(storeRaw, { now: NOW });
  const merged = mergeCoupons([my, store], { now: NOW });

  check("同一张券合并成一张", () => {
    return eq(merged.length, 1);
  });
  check("合并后同时保留「用券价格」语义与适用商品编码", () => {
    const c = merged[0];
    return eq(
      [c.valueKind === "coupon_price", (c.itemCodes || []).length > 0],
      [true, true]
    );
  });
  check("合并后保留卡包券的面额（门店券的 0 不能覆盖）", () => {
    return eq(merged[0].value > 0, true);
  });
  check("合并后保留时段限制", () => {
    return eq(merged[0].dayWindow !== "", true);
  });
  check("sources 记录了券在哪些视角下可见", () => {
    return eq((merged[0].sources || []).length >= 2, true);
  });
  check("合并后券码可用（calculate-price 需要）", () => {
    return eq(!!merged[0].code, true);
  });
} else {
  console.log("  ⚠ 缺少 fixtures/live 数据，跳过合并测试");
}

// ---------------------------------------------------------------------------
console.log("\n【券实际优惠额 · calculate-price 口径】");
// ---------------------------------------------------------------------------

check("不带券返回原价 0 时，不能拿 0 当原价", () => {
  const cmp = comparePricings(
    { data: { originalPrice: 0, price: 0, discount: 0 } },
    { data: { originalPrice: 0, price: 2048, discount: 1352 } }
  );
  // 带券时服务端给了 discount=1352 分 → 可测算，且原价 = 实付 + 减免
  return eq(cmp.known, true);
});

check("原价 = 实付 + 减免（当原价不可售时）", () => {
  const cmp = comparePricings(
    { data: { originalPrice: 0, price: 0, discount: 0 } },
    { data: { originalPrice: 0, price: 2048, discount: 1352 } }
  );
  return eq(cmp.originalYuan, 34);
});

check("实省金额 = 服务端减免额 / 100", () => {
  const cmp = comparePricings(
    { data: { originalPrice: 0, price: 0, discount: 0 } },
    { data: { originalPrice: 0, price: 2048, discount: 1352 } }
  );
  return eq(cmp.saving, 13.52);
});

check("带券算价失败时如实报未知", () => {
  const cmp = comparePricings(
    { data: { originalPrice: 3400, price: 3400, discount: 0 } },
    { data: { originalPrice: 0, price: 0, discount: 0 } }
  );
  return eq(cmp.known, false);
});

check("正常场景：原价 - 实付 = 优惠额", () => {
  const cmp = comparePricings(
    { data: { originalPrice: 3400, price: 3400, discount: 0 } },
    { data: { originalPrice: 3400, price: 2048, discount: 1352 } }
  );
  return eq([cmp.known, cmp.originalYuan, cmp.payableYuan, cmp.saving], [true, 34, 20.48, 13.52]);
});

check("extractPricing 能识别「原价 0 = 没取到」而非「原价是 0」", () => {
  const p = extractPricing({ data: { originalPrice: 0, price: 0 } });
  return eq(p.hasOriginal, false);
});

check("汇总：无计价数据的券标记为未测算", () => {
  const s = summarizeCouponValues(
    [{ id: "x", name: "测试券", value: 20.48, valueKind: "coupon_price" }],
    {}
  );
  return eq([s.knownCount, s.unknownCount], [0, 1]);
});

check("汇总：能挑出最值钱的券", () => {
  const s = summarizeCouponValues(
    [
      { id: "a", name: "A", value: 10, valueKind: "coupon_price" },
      { id: "b", name: "B", value: 20, valueKind: "coupon_price" },
    ],
    {
      a: { without: { data: { originalPrice: 0, price: 0 } }, with: { data: { price: 1000, discount: 500 } } },
      b: { without: { data: { originalPrice: 0, price: 0 } }, with: { data: { price: 1000, discount: 1500 } } },
    }
  );
  return eq(s.best?.name, "B");
});

// ---------------------------------------------------------------------------
console.log("\n【门店促销规则 · 结构化且带渠道约束】");
// ---------------------------------------------------------------------------

const promoRaw = load("promotions");
if (promoRaw) {
  const promos = collectPromotions(promoRaw, { beType: 1, now: NOW });

  check("促销规则能被解析出门槛与减免额", () => {
    return eq(promos.every((p) => p.threshold > 0 && p.discount > 0), true);
  });
  check("促销规则带渠道标记 beTypes", () => {
    return eq(promos.every((p) => p.beTypes.length > 0), true);
  });
  check("渠道判定不在采集阶段固化（留给分析阶段，因为它依赖运行时就餐方式）", () => {
    return eq(promos.every((p) => p.appliesToChannel === null), true);
  });

  const analysis = analyzePromotionRules(promos, { now: NOW, beType: 1 });
  check("到店自取场景下没有可用规则（实测这 12 条都是团餐）", () => {
    return eq(analysis.effective.length, 0);
  });
  check("渠道不符的规则被单独归类", () => {
    return eq(analysis.channelMismatch.length > 0, true);
  });
  check("结论里说明「这些规则到店用不上」", () => {
    return eq(/不生效|用不上/.test(analysis.note), true);
  });

  const g6 = analyzePromotionRules(promos, { now: NOW, beType: 6 });
  check("团餐场景下规则生效", () => {
    return eq(g6.effective.length > 0, true);
  });
  check("阶梯递减被识别（门槛越高单条最优折扣率越低）", () => {
    return eq(g6.decreasing, true);
  });
  check("最优档是单条折扣率最高的那个", () => {
    return eq(g6.best.bestRate, Math.max(...g6.effective.map((r) => r.rate)));
  });
  check("同门槛多条规则被归为一个档位", () => {
    return eq(g6.tiers.every((t) => t.count >= 1), true);
  });
  check("同门槛多条时给出「若叠加」的参考值（但不假定叠加）", () => {
    const t = g6.tiers.find((x) => x.count > 1);
    return eq(t.stackedDiscount > t.best.discount, true);
  });
  check("结论里说明同门槛多条规则能否叠加不确定", () => {
    return eq(/能否同时生效|叠加/.test(g6.note), true);
  });
  check("最优策略判定为「压最低档门槛」", () => {
    return eq(g6.strategy, "压最低档门槛");
  });

  check("凑单判定：已达门槛时用减免最大的档", () => {
    const r = bestPromotionFor(g6.effective, 1200);
    return eq(r.saving > 0, true);
  });
  check("凑单判定：未达门槛时给出还差多少", () => {
    const r = bestPromotionFor(g6.effective, 50);
    return eq(/还差/.test(r.reason), true);
  });
} else {
  console.log("  ⚠ 缺少 fixtures/live/promotions.json，跳过促销规则测试");
}

// ---------------------------------------------------------------------------
console.log("\n【门店菜单】");
// ---------------------------------------------------------------------------

const menuRaw = load("meals");
if (menuRaw) {
  const menu = collectMenuItems(menuRaw);
  check("菜单能解析出餐品", () => {
    return eq(menu.length > 0, true);
  });
  check("餐品带现价与原价", () => {
    return eq(menu.every((m) => m.currentPrice > 0), true);
  });
  check("划线价高于现价的商品能算出自身优惠额", () => {
    const withSaving = menu.filter((m) => m.ownSaving > 0);
    return eq(withSaving.length > 0 && withSaving.every((m) => m.ownSaving > 0), true);
  });
  check("分类信息被合并进来（详情在映射表，分类在 categories）", () => {
    return eq(menu.some((m) => m.category !== ""), true);
  });
} else {
  console.log("  ⚠ 缺少 fixtures/live/meals.json，跳过菜单测试");
}


console.log("\n【券的同一性 · couponId 是唯一可靠标识】");
{
  // 实测（2026-10-23 领券后）：卡包 5 张，其中同名「11.9元麦辣鸡腿堡」有两张，
  // couponId 不同（A2552803… 到期 10-23 / B34E5EC6… 到期 10-30）—— 不同批次。
  const mk = (id, name, expireAt, extra = {}) => ({
    id, code: id, name, value: 20.48, valueKind: "coupon_price",
    expireAt, expireText: expireAt, dayWindow: "10:30-23:59",
    weekdays: [], channel: ["pickup"], validFrom: null,
    source: "my", status: "已领取", itemCodes: [], itemNames: [],
    stackable: false, usableSlots: null, ...extra,
  });

  check("同名但 couponId 不同 → 保留为两张（不同批次）", () => {
    const m = mergeCoupons([
      [mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z")],
      [mk("B34E", "11.9元麦辣鸡腿堡", "2026-10-30T15:59:59.000Z")],
    ], { now: NOW });
    return eq(m.length, 2);
  });

  check("同一 couponId 出现在两路 → 合并成一张", () => {
    const m = mergeCoupons([
      [mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z")],
      [{ ...mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z"),
         source: "store", itemCodes: ["1440"], itemNames: ["麦辣鸡腿汉堡"],
         value: 0, valueKind: "discount_amount" }],
    ], { now: NOW });
    return eq(m.length, 1);
  });

  check("合并后仍保留适用商品编码（门店视角）", () => {
    const m = mergeCoupons([
      [mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z")],
      [{ ...mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z"),
         source: "store", itemCodes: ["1440"], itemNames: ["麦辣鸡腿汉堡"],
         value: 0, valueKind: "discount_amount" }],
    ], { now: NOW });
    return eq((m[0].itemCodes || []).length > 0, true);
  });

  check("合并后仍保留卡包的面额（门店的 0 不能覆盖）", () => {
    const m = mergeCoupons([
      [mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z")],
      [{ ...mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z"),
         source: "store", value: 0, valueKind: "discount_amount" }],
    ], { now: NOW });
    return eq(m[0].value, 20.48);
  });

  check("麦麦省已领取的券不再算「可领取」", () => {
    const m = mergeCoupons([
      [mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z")],
      [{ name: "11.9元麦辣鸡腿堡", value: 0, valueKind: "discount_amount",
         expireAt: null, expireText: "", dayWindow: "", weekdays: [], channel: [],
         validFrom: null, source: "mcd-savers", status: "可领取",
         itemCodes: [], itemNames: [], stackable: false, usableSlots: null,
         id: "mcd-savers-0-11.9元麦辣鸡腿堡" }],
    ], { now: NOW });
    // 卡包已有同名券 → 麦麦省那条要么标记为「已领取」，
    // 要么（因信息重复）被丢弃 —— 但**绝不能仍是「可领取」**。
    const s = m.find((x) => x.source === "mcd-savers");
    return eq(s === undefined || s.status === "已领取", true);
  });

  check("卡包已有同名券时，麦麦省的无信息行被丢弃（不产生空条目）", () => {
    const m = mergeCoupons([
      [mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z")],
      [{ name: "11.9元麦辣鸡腿堡", value: 0, valueKind: "discount_amount",
         expireAt: null, expireText: "", dayWindow: "", weekdays: [], channel: [],
         validFrom: null, source: "mcd-savers", status: "已领取",
         itemCodes: [], itemNames: [], stackable: false, usableSlots: null,
         id: "mcd-savers-0-11.9元麦辣鸡腿堡" }],
    ], { now: NOW });
    return eq(m.length, 1);
  });

  check("卡包里没有的麦麦省券仍然保留（真的还没领）", () => {
    const m = mergeCoupons([
      [mk("A255", "11.9元麦辣鸡腿堡", "2026-10-23T15:59:59.000Z")],
      [{ name: "免费脆薯饼", value: 0, valueKind: "discount_amount",
         expireAt: null, expireText: "", dayWindow: "", weekdays: [], channel: [],
         validFrom: null, source: "mcd-savers", status: "可领取",
         itemCodes: [], itemNames: [], stackable: false, usableSlots: null,
         id: "mcd-savers-2-免费脆薯饼" }],
    ], { now: NOW });
    return eq(m.length, 2);
  });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
