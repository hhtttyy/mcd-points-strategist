/**
 * mcd-points-strategist · 券叠加求解
 *
 * 给定一篮子商品和一组券，算出用券后的实付。
 *
 * 核心原则（借 mcd-saver-strategist 的保守策略）：
 *   **算出的价格必须 ≤ 用户实际支付价。宁可少报优惠，也不给用户一个
 *   到店里付不出来的「假便宜」。**
 *
 * 保守体现在四处：
 *   1. `stackable` 拿不准一律视为互斥
 *   2. 券面规则认不出来时不猜价，按不叠加处理
 *   3. 满减取「满足门槛的最大抵扣」，不叠加多张满减
 *   4. 折扣与改价同时命中同一商品时，取更便宜的那个（min），不叠乘
 *
 * 本模块是纯函数，不碰 IO。
 */

import { conflicts, findCompatibleSets } from "./coupon-model.mjs";

// --------------------------------------------------------------------------
// 计价
// --------------------------------------------------------------------------

/**
 * 用一组券给一篮子商品计价。
 *
 * @param {Array}  basket   [{code, name, price, quantity?}]
 * @param {Array}  coupons  券对象（须已过 classify/parseCouponTerms）
 * @param {object} opts
 * @param {number} [opts.deliveryFee] 外送配送费
 * @returns {object} 计价明细
 */
export function priceBasket(basket, coupons = [], opts = {}) {
  const items = normalizeItems(basket);
  const deliveryFee = opts.deliveryFee || 0;

  const byCode = new Map(items.map((it) => [it.code, it]));
  const priceOverrides = new Map(); // code -> 固定价
  const percentOverrides = new Map(); // code -> 折扣率
  const bundleLines = [];
  const consumed = new Set();
  const applied = [];
  const rejected = [];

  for (const cp of coupons) {
    const ct = cp.type;

    if (ct === "item_price") {
      const usable = (cp.itemCodes || []).filter((c) => byCode.has(c));
      if (!usable.length) {
        rejected.push({ coupon: cp.name, reason: "券适用商品不在购物篮中" });
        continue;
      }
      for (const c of usable) {
        const cur = priceOverrides.get(c);
        const target = cp.overridePrice ?? cp.faceValue;
        priceOverrides.set(c, cur === undefined ? target : Math.min(cur, target));
      }
      applied.push({ coupon: cp.name, type: ct, on: usable });
    } else if (ct === "percent") {
      const usable = (cp.itemCodes || []).filter((c) => byCode.has(c));
      if (!usable.length) {
        rejected.push({ coupon: cp.name, reason: "券适用商品不在购物篮中" });
        continue;
      }
      for (const c of usable) {
        const cur = percentOverrides.get(c);
        const rate = cp.discountPct;
        percentOverrides.set(c, cur === undefined ? rate : Math.min(cur, rate));
      }
      applied.push({ coupon: cp.name, type: ct, on: usable });
    } else if (ct === "bundle_price") {
      const picked = [];
      for (const group of cp.groups || []) {
        const cand = group.filter((c) => byCode.has(c) && !consumed.has(c));
        if (!cand.length) {
          rejected.push({ coupon: cp.name, reason: "组合价券凑不齐" });
          picked.length = 0;
          break;
        }
        // 组合价覆盖到每组里最贵的那件，把便宜件留在外面
        cand.sort((a, b) => byCode.get(b).price - byCode.get(a).price);
        picked.push(cand[0]);
        consumed.add(cand[0]);
      }
      if (picked.length) {
        bundleLines.push({
          coupon: cp.name,
          codes: picked,
          price: cp.faceValue,
        });
        applied.push({ coupon: cp.name, type: ct, on: picked });
      }
    } else if (ct === "threshold") {
      // 满减在商品小计算完后统一处理
      applied.push({ coupon: cp.name, type: ct, deferred: true });
    } else if (ct === "free_gift") {
      applied.push({ coupon: cp.name, type: ct, deferred: true });
    } else {
      rejected.push({ coupon: cp.name, reason: `券类型无法识别（${ct}）` });
    }
  }

  // ---- 商品小计 ----
  const lines = [];
  let subtotal = 0;
  for (const it of items) {
    if (consumed.has(it.code)) continue; // 已被组合价打包
    const base = it.price;
    let eff = base;
    const tags = [];
    if (priceOverrides.has(it.code)) {
      eff = Math.min(eff, priceOverrides.get(it.code));
      tags.push("单品券价");
    }
    if (percentOverrides.has(it.code)) {
      eff = Math.min(eff, round(base * percentOverrides.get(it.code)));
      tags.push("折扣");
    }
    subtotal += eff;
    lines.push({ code: it.code, name: it.name, price: round(eff), qty: it.qty, tag: tags.join("+") });
  }

  for (const bl of bundleLines) {
    subtotal += bl.price;
    lines.push({
      code: bl.codes.join("+"),
      name: bl.coupon,
      price: round(bl.price),
      qty: 1,
      tag: "组合价",
    });
  }

  subtotal = round(subtotal);

  // ---- 满减：取满足门槛的最大抵扣（保守，不叠加多张）----
  let thresholdDiscount = 0;
  let thresholdCoupon = null;
  for (const cp of coupons) {
    if (cp.type !== "threshold") continue;
    const min = cp.threshold || 0;
    const disc = cp.faceValue || 0;
    if (subtotal >= min && disc > thresholdDiscount) {
      thresholdDiscount = disc;
      thresholdCoupon = cp.name;
    }
  }

  // ---- 赠品：门槛校验后发放 ----
  const gifts = [];
  for (const cp of coupons) {
    if (cp.type !== "free_gift") continue;
    if (subtotal >= (cp.threshold || 0)) {
      for (const g of cp.giftCodes || []) gifts.push(g);
    }
  }

  const total = round(Math.max(subtotal - thresholdDiscount, 0));
  const withDelivery = round(total + deliveryFee);

  return {
    lines,
    subtotal,
    thresholdCoupon,
    thresholdDiscount: round(thresholdDiscount),
    gifts: [...new Set(gifts)],
    deliveryFee: round(deliveryFee),
    total,
    payable: withDelivery,
    applied,
    rejected,
  };
}

// --------------------------------------------------------------------------
// 券组合求解
// --------------------------------------------------------------------------

/**
 * 在一组候选券里，找出对当前购物篮**净收益最高**的组合。
 *
 * 净收益 = 用了券后的实付减少量。
 * 但这里有个陷阱：为了用券可能需要凑单 —— 那笔开销要算进去。
 * 所以净收益 = (不用券的实付) - (用券后的实付 + 凑单成本)。
 *
 * @param {Array} basket
 * @param {Array} coupons
 * @param {object} opts
 * @param {Array}  [opts.menu]        可加购商品（用于算凑单成本）
 * @param {number} [opts.deliveryFee]
 * @param {boolean}[opts.allowFiller]  是否允许为用券而加购（默认 false）
 */
export function solveCouponPlan(basket, coupons, opts = {}) {
  const items = normalizeItems(basket);
  const baseline = priceBasket(items, [], opts);
  const candidates = (coupons || []).filter(Boolean);

  if (!candidates.length) {
    return {
      plan: null,
      baseline,
      note: "没有可用券",
      alternatives: [],
    };
  }

  const sets = findCompatibleSets(candidates, 64);
  const results = [];

  for (const set of sets) {
    const priced = priceBasket(items, set, opts);
    const saving = round(baseline.payable - priced.payable);

    // 凑单成本：若券有门槛而当前小计不够，需要额外消费
    let fillerCost = 0;
    let fillerInfo = null;
    for (const cp of set) {
      if (cp.type !== "threshold") continue;
      if (priced.subtotal >= (cp.threshold || 0)) continue;
      const gap = round((cp.threshold || 0) - priced.subtotal);
      const need = round(Math.min(gap, cp.faceValue || gap));
      if (need > 0) {
        fillerCost = round(Math.max(fillerCost, need));
        fillerInfo = { coupon: cp.name, need, gap };
      }
    }

    const netSaving = round(saving - fillerCost);
    results.push({
      coupons: set.map((c) => c.name),
      priced,
      saving,
      fillerCost,
      fillerInfo,
      netSaving,
      worthwhile: netSaving > 0,
    });
  }

  results.sort((a, b) => b.netSaving - a.netSaving);

  const best = results.find((r) => r.worthwhile) || null;
  const alternatives = results.filter((r) => r !== best && r.saving > 0).slice(0, 5);

  return {
    plan: best,
    baseline,
    alternatives,
    allResults: results,
    note: best
      ? `最优组合省 ¥${best.netSaving}（毛省 ¥${best.saving}${best.fillerCost ? `，扣凑单 ¥${best.fillerCost}` : ""}）`
      : candidates.length
        ? "现有券对你这单没有净收益，不建议为用券而凑单"
        : "没有可用券",
  };
}

// --------------------------------------------------------------------------
// 凑单陷阱检测
// --------------------------------------------------------------------------

/**
 * 检测「为用券凑单反而不划算」的情况。
 *
 * 只比较**商品构成相同、仅券不同**的方案对 ——
 * 把完全不同商品组合的方案拿来互比会产生大量噪音警告。
 *
 * @param {Array} pricedPlans [{label, items, payable, coupon}]
 */
export function detectFillerTraps(pricedPlans = []) {
  const groups = new Map();
  for (const p of pricedPlans) {
    const key = fingerprint(p.items);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const warnings = [];
  for (const group of groups.values()) {
    const noCoupon = group.filter((p) => !p.coupon);
    const withCoupon = group.filter((p) => p.coupon);
    if (!noCoupon.length || !withCoupon.length) continue;

    const baseline = noCoupon.reduce((a, b) => (a.payable <= b.payable ? a : b));
    for (const cand of withCoupon) {
      if (cand.payable >= baseline.payable) {
        warnings.push({
          trap: cand.label,
          trapPayable: cand.payable,
          alternative: baseline.label,
          alternativePayable: baseline.payable,
          delta: round(cand.payable - baseline.payable),
          message:
            `「${cand.label}」用了券之后实付 ${cand.payable} 元，` +
            `并不比直接下单的 ${baseline.payable} 元更便宜 —— ` +
            `这张券对这一单没有价值，不必为它凑单。`,
        });
      }
    }
  }
  return warnings;
}

// --------------------------------------------------------------------------
// 工具
// --------------------------------------------------------------------------

/**
 * 商品构成指纹 —— 用于把「同商品、仅券不同」的方案分到一组。
 */
export function fingerprint(items = []) {
  return items
    .map((i) => `${i.code}×${i.qty ?? 1}`)
    .sort()
    .join("|");
}

function normalizeItems(basket) {
  return (basket || [])
    .map((it) => ({
      code: String(it.code ?? it.productCode ?? ""),
      name: String(it.name ?? it.productName ?? ""),
      price: Number(it.price ?? 0) || 0,
      qty: Number(it.quantity ?? it.qty ?? 1) || 1,
    }))
    .filter((it) => it.code && it.price > 0);
}

function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round(v * f) / f;
}
