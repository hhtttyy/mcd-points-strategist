/**
 * mcd-points-strategist · 券实际优惠额测算
 *
 * 解决一个核心问题：**卡包券的 `discountDesc` 是「用券价格」（你付的钱），
 * 不是「省的钱」**。所以「这张券值多少」必须拿**原价对比**才能算。
 *
 * ⚠️ 为什么不能靠菜单表推算：
 *   券的适用商品是**套餐 SKU**（如 `9900016523` 龙焰鸡腿堡两件套），
 *   而菜单表里常常**没有这个 SKU**（只有单品、三件套、四件套），
 *   且「套餐原价」≠ 「各单品原价之和」（套餐有组合价）。
 *   实测（2026-10-23 六道口店）：券适用 `9900016523` 不在菜单 120 项里。
 *
 * ✅ 唯一可靠的办法：`calculate-price` 跑两次。
 *   ① 不带券 → `originalPrice`（原价，单位**分**）
 *   ② 带券   → `price`（实付，单位**分**）
 *   优惠额 = (originalPrice - price) / 100
 *
 *   这个接口是**只读**的（不创建订单），所以可以安全地用于测算。
 *
 * ⚠️ 单位：`calculate-price` 的金额字段是**分**（"3400" = 34 元），
 *    而 `query-meals` 的 `currentPrice` 是**元**（"26.9"）。
 *    两个接口方向相反 —— 这是本项目最容易出错的地方。
 *
 * 本模块是纯函数：只接收已取到的两次计价结果，不发起网络请求。
 */

/** 分 → 元 */
function centsToYuan(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / 100) * 100) / 100;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 从 `calculate-price` 的响应里抽出计价结果。
 *
 * ⚠️ 实测坑：某些商品组合**不带券**时返回全 0（`productOriginalPrice: 0`），
 *    但带券时正常返回。推测是不带券时该组合不满足某些结算条件。
 *    所以「原价」拿不到时不能填 0 当原价 —— 必须报「无法测算」。
 *
 * @param {object} res MCP 响应
 */
export function extractPricing(res) {
  const d = res?.data || res || {};
  const original = num(d.originalPrice ?? d.productOriginalPrice);
  const payable = num(d.price ?? d.productPrice);
  const discount = num(d.discount);
  const items = (d.productList || []).map((p) => ({
    code: String(p.productCode || ""),
    name: String(p.productName || ""),
    quantity: num(p.quantity, 1),
    originalSubtotal: num(p.originalSubtotal),
    subtotal: num(p.subtotal),
  }));

  return {
    originalYuan: centsToYuan(original),
    payableYuan: centsToYuan(payable),
    discountYuan: centsToYuan(discount),
    // ⚠️ 原价为 0 意味着「没取到原价」，不是「原价是 0」
    hasOriginal: original > 0,
    hasPayable: payable > 0,
    items,
    raw: { original, payable, discount },
  };
}

/**
 * 比对两次计价（不带券 vs 带券），得出券的真实优惠额。
 *
 * @param {object} withoutCoupon  不带券的 calculate-price 响应
 * @param {object} withCoupon     带券的 calculate-price 响应
 */
export function comparePricings(withoutCoupon, withCoupon) {
  const a = extractPricing(withoutCoupon);
  const b = extractPricing(withCoupon);

  if (!b.hasPayable) {
    return {
      known: false,
      reason: "带券算价失败，无法确认券是否真的能用于这个组合",
      without: a,
      with: b,
    };
  }

  // ⚠️ 关键口径（实测 2026-10-23）：
  //   有些商品组合**不带券时算价返回全 0** —— 意味着该组合原价不可售
  //   （必须用券才能下单）。此时「不带券的原价」拿不到，
  //   **绝不能拿 0 当原价**（会算出 20.48 的荒谬优惠额）。
  //
  //   正确的口径是：**服务端在带券时返回的 `discount` 字段**，
  //   它就是这笔订单被减免的金额（单位分）。
  //   实测：原价 3400 分 / 实付 2048 分 / discount 1352 分 → 券省 ¥13.52。
  if (!a.hasOriginal) {
    if (b.discountYuan > 0) {
      return {
        known: true,
        saving: b.discountYuan,
        // 原价 = 实付 + 减免（服务端只给实付，但减免额是权威的）
        originalYuan: Math.round((b.payableYuan + b.discountYuan) * 100) / 100,
        payableYuan: b.payableYuan,
        rate:
          b.payableYuan + b.discountYuan > 0
            ? Math.round((b.discountYuan / (b.payableYuan + b.discountYuan)) * 10000) / 10000
            : null,
        items: b.items,
        without: a,
        with: b,
        noOriginalBaseline: true,
        reason:
          `该组合原价不可售（必须用券下单），按服务端减免额计算：减 ¥${b.discountYuan}，` +
          `实付 ¥${b.payableYuan}（原价约 ¥${Math.round((b.payableYuan + b.discountYuan) * 100) / 100}）`,
      };
    }
    return {
      known: false,
      reason:
        "不带券算价返回原价 0（该组合原价不可售，必须用券下单），" +
        "且带券时服务端未给出减免额 —— 无法测算，不拿 0 当原价",
      without: a,
      with: b,
    };
  }

  // 优惠额优先用服务端给的 discount；没有就用原价 - 实付
  const saving =
    b.discountYuan > 0 ? b.discountYuan : Math.round((a.originalYuan - b.payableYuan) * 100) / 100;

  return {
    known: true,
    saving,
    originalYuan: a.originalYuan,
    payableYuan: b.payableYuan,
    rate: a.originalYuan > 0 ? Math.round((saving / a.originalYuan) * 10000) / 10000 : null,
    items: b.items,
    without: a,
    with: b,
    reason:
      `原价 ¥${a.originalYuan} → 用券后 ¥${b.payableYuan}，实省 ¥${saving}` +
      (a.originalYuan > 0 ? `（${((saving / a.originalYuan) * 100).toFixed(1)}% off）` : ""),
  };
}

/**
 * 券的「真实价值」汇总 —— 供看板与决策层使用。
 *
 * 输出的语义是「这张券实际能省多少钱」，而不是「券面标了多少」。
 * 两者不同：券面标的是用券价格。
 *
 * @param {Array}  coupons  券（已合并三路）
 * @param {Object} pricing  { [couponId]: { without, with } } 两次计价结果
 */
export function summarizeCouponValues(coupons = [], pricing = {}) {
  const list = (coupons || []).filter(Boolean);
  const out = [];

  for (const c of list) {
    const key = c.id || c.code;
    const pair = pricing[key];
    if (!pair) {
      out.push({
        id: c.id,
        name: c.name,
        known: false,
        faceValue: c.value,
        valueKind: c.valueKind,
        reason: c.valueKind === "coupon_price" ? "尚未测算实际优惠额" : "无适用商品可测算",
      });
      continue;
    }
    const cmp = comparePricings(pair.without, pair.with);
    out.push({
      id: c.id,
      name: c.name,
      known: cmp.known,
      saving: cmp.known ? cmp.saving : null,
      originalYuan: cmp.originalYuan ?? null,
      payableYuan: cmp.payableYuan ?? null,
      rate: cmp.rate ?? null,
      faceValue: c.value,
      valueKind: c.valueKind,
      reason: cmp.reason,
    });
  }

  const known = out.filter((x) => x.known);
  return {
    items: out,
    knownCount: known.length,
    unknownCount: out.length - known.length,
    totalSaving: Math.round(known.reduce((s, x) => s + (x.saving || 0), 0) * 100) / 100,
    best: known.length ? known.reduce((a, b) => ((b.saving || 0) > (a.saving || 0) ? b : a)) : null,
  };
}
