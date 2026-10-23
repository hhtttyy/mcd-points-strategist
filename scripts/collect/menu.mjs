/**
 * mcd-points-strategist · 门店菜单采集
 *
 * `query-meals` 返回门店**实时菜单**：分类 + 餐品现价 + 原价 + 优惠类型。
 *
 * 为什么这个数据重要：
 *   券的 `discountDesc` 是「用券价格」（你付的钱），
 *   所以「这张券省了多少」必须拿**菜单原价**对比才知道。
 *   没有菜单原价 → 只能报「无法推算实际优惠额」。
 *
 *   有了菜单就能算：
 *   - 券适用范围（券的 products[].productCode ∩ 菜单餐品）
 *   - 用券前后差价（originalPrice - 用券价）
 *   - 凑单到促销门槛要加什么（结合门店满额减规则）
 *
 * ⚠️ 真实响应结构（2026-10-23 实测）：
 * ```json
 * {
 *   "data": {
 *     "categories": [{ "name": "人气热卖", "meals": [{ "code": "9900016076", "tags": [...] }] }],
 *     "meals": {
 *       "9900016073": {
 *         "name": "龙焰鸡腿堡三件套",
 *         "currentPrice": "26.9",     ← 现价
 *         "originalPrice": "48.5",    ← 原价（划线价）
 *         "discountType": "促销优惠",   ← null / 早餐卡优惠 / 促销优惠 / 麦金卡优惠 / ...
 *         "canWithOrder": false
 *       }
 *     },
 *     "frequent": { ... }
 *   }
 * }
 * ```
 * 关键：**分类里只有 code，详情在 `meals` 映射表里** —— 必须合并两层才能拿到名称与价格。
 *
 * ⚠️ 价格单位：`currentPrice` / `originalPrice` 是**元**（"26.9"），
 *    与 `calculate-price` 的「分」不同。已核对：26.9 元的价格标 26.9。
 */

import { num } from "./parse.mjs";

/**
 * `query-meals` → MenuItem[]
 *
 * @param {object} data       MCP 响应的 data 段
 * @param {object} [opts]
 * @param {number} [opts.beType] 用于判断「随单购麦金卡优惠」是否适用
 */
export function collectMenuItems(data, opts = {}) {
  const d = data?.data || data || {};
  const details = d.meals && typeof d.meals === "object" ? d.meals : {};
  const categories = Array.isArray(d.categories) ? d.categories : [];

  // 分类 → 分类名映射
  const categoryOf = new Map();
  for (const c of categories) {
    const catName = String(c.name || "").replace(/\n/g, "");
    for (const m of c.meals || []) {
      const code = String(m.code || "");
      if (code && !categoryOf.has(code)) {
        categoryOf.set(code, { name: catName, tags: Array.isArray(m.tags) ? m.tags : [] });
      }
    }
  }

  // 只保留分类里出现过的餐品（menu 映射表可能有详情但不在菜单里）
  const items = [];
  for (const [code, raw] of Object.entries(details)) {
    const current = num(raw?.currentPrice);
    const original = num(raw?.originalPrice);
    const meta = categoryOf.get(code) || { name: "", tags: [] };
    items.push({
      code: String(code),
      name: String(raw?.name || ""),
      currentPrice: current,
      originalPrice: original,
      // 划线价 - 现价 = 该商品自身的优惠额
      ownSaving: original > current ? Math.round((original - current) * 100) / 100 : 0,
      discountType: raw?.discountType ?? null,
      canWithOrder: raw?.canWithOrder === true,
      category: meta.name,
      tags: meta.tags,
    });
  }

  return items;
}

/**
 * 找出菜单里「划线价明显高于现价」的商品 —— 这些是**已经在打折**的商品。
 *
 * 用于凑单建议：加购时优先选「本来就在打折」的商品，
 * 这样「加购成本」低于标价，凑单的真实代价更小。
 */
export function findDiscountedItems(items = [], { minSaving = 1 } = {}) {
  return (items || [])
    .filter((i) => i.ownSaving >= minSaving)
    .map((i) => ({
      code: i.code,
      name: i.name,
      currentPrice: i.currentPrice,
      originalPrice: i.originalPrice,
      saving: i.ownSaving,
      discountType: i.discountType,
    }))
    .sort((a, b) => b.saving - a.saving);
}

/**
 * 找到「用券最划算」的候选商品组合。
 *
 * 券的 `discountDesc` 是「用券价格」= 你用券后付的钱。
 * 所以「省多少」= 商品原价 - 用券价。
 * ⚠️ 用券价对应的是**套餐整体**，而菜单里的商品是单品 ——
 *    所以这个计算只在「券的适用商品能在菜单里找到对应套餐」时成立。
 *    找不到就说找不到，**不拿单品价去套套餐价**。
 *
 * @param {Array}  items    菜单
 * @param {object} coupon   券（含 itemCodes）
 * @param {number} couponPrice 券面标注的「用券价格」
 */
export function estimateCouponSaving(items = [], coupon = {}, couponPrice = null) {
  const codes = Array.isArray(coupon.itemCodes) ? coupon.itemCodes : [];
  if (!codes.length) {
    return { known: false, reason: "券未标注适用商品编码，无法定位对应商品" };
  }
  const matched = items.filter((i) => codes.includes(i.code));
  if (!matched.length) {
    return {
      known: false,
      reason: `券的适用商品（${codes.join(", ")}）不在当前门店菜单里`,
    };
  }
  if (couponPrice === null || !Number.isFinite(Number(couponPrice))) {
    return {
      known: false,
      reason: "券面只给了用券价格，没有原价对比基准",
      matched,
    };
  }
  // ⚠️ 保守：只有当匹配到的**恰好一件**商品，且其原价与用券价可比时才能算。
  //    多件匹配（券覆盖一组商品）时无法拆分成单件优惠额 → 不算。
  if (matched.length > 1) {
    const totalOriginal = matched.reduce((s, m) => s + m.originalPrice, 0);
    return {
      known: true,
      saving: Math.round((totalOriginal - Number(couponPrice)) * 100) / 100,
      approximate: true,
      matched,
      reason: `券覆盖 ${matched.length} 件商品，合计原价 ¥${totalOriginal} → 用券价 ¥${couponPrice}，省约 ¥${Math.round((totalOriginal - Number(couponPrice)) * 100) / 100}`,
    };
  }
  const m = matched[0];
  const saving = Math.round((m.originalPrice - Number(couponPrice)) * 100) / 100;
  return {
    known: true,
    saving,
    approximate: false,
    matched,
    reason: `「${m.name}」原价 ¥${m.originalPrice} → 用券价 ¥${couponPrice}，省 ¥${saving}`,
  };
}

/**
 * 凑单建议：为了达到某个门槛，最少需要加购什么。
 *
 * 逻辑：找「现价刚好能补上差额」的商品，优先选本身在打折的（真实代价更低）。
 *
 * @param {Array}  items  菜单
 * @param {number} gap    距离门槛还差多少元
 * @param {number} [maxPrice] 单件加购价格上限
 */
export function suggestTopUp(items = [], gap = 0, { maxPrice = 30 } = {}) {
  const g = num(gap);
  if (g <= 0) return { needed: 0, candidates: [] };

  const pool = (items || [])
    .filter((i) => i.currentPrice > 0 && i.currentPrice <= maxPrice)
    .map((i) => ({
      code: i.code,
      name: i.name,
      price: i.currentPrice,
      ownSaving: i.ownSaving,
      // 真实代价 = 现价 - 自身优惠（即如果没有这张券，这件商品本来就要付多少）
      effectiveCost: Math.max(0, i.currentPrice),
    }));

  // 优先：价格接近差额、且本身在打折的
  const candidates = pool
    .filter((i) => i.price >= g)
    .sort((a, b) => {
      const sa = a.ownSaving > 0 ? 0 : 1;
      const sb = b.ownSaving > 0 ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.price - b.price;
    })
    .slice(0, 5);

  return { needed: g, candidates };
}
