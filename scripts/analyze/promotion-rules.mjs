/**
 * mcd-points-strategist · 门店促销规则分析
 *
 * 把 `query-promotions` 返回的**结构化促销规则**变成可决策的结论。
 *
 * 为什么单独一个模块：
 *   早先把促销当成「文案」处理（只取 title/description），
 *   但实测发现它返回的是**规则**：
 *     ruleDetail.orderDiscount = { discount: "26", startDiscountPoint: "500" }
 *   语义是「订单满 500 元减 26 元」。
 *   这类规则**可以真正参与计算** —— 不像营销文案那样只能做提醒。
 *
 * ⚠️ 最重要的前提：促销带 `beTypes` 渠道标记。
 *   实测该工具忽略传入的 beType —— 传 beType=1 也会返回团餐（beTypes:["6"]）的规则。
 *   所以必须按渠道过滤，否则会把「到店用不上的团餐优惠」报成「今天这家店的优惠」。
 *
 * 本模块是纯函数，不碰 IO。
 */

/** beType → 中文名 */
const BE_TYPE_NAMES = {
  1: "到店自取",
  2: "麦乐送",
  5: "得来速",
  6: "团餐",
};

function round(v, p = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 解析促销规则的折扣率。
 *
 * 满额减的折扣率 = 减免额 / 门槛。
 * ⚠️ 门槛越高，**折扣率越低**（满 300 减 22 = 7.3%，满 2000 减 34 = 1.7%）。
 *    这与「凑单越贵越划算」的直觉相反 —— 麦当劳的阶梯是**递减**的。
 *    所以最优策略是**刚好压在最低档门槛上**，而不是买越多越省。
 */
export function analyzePromotionRules(promotions = [], opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const beType = opts.beType ?? null;
  const list = (promotions || []).filter(Boolean);

  const rules = list.map((p) => {
    const threshold = num(p.threshold);
    const discount = num(p.discount);
    const rate = threshold > 0 ? round(discount / threshold, 4) : null;
    const endAt = p.endAt ? new Date(String(p.endAt).replace(" ", "T")) : null;
    const startAt = p.startAt ? new Date(String(p.startAt).replace(" ", "T")) : null;
    const isLive = (!startAt || startAt <= now) && (!endAt || endAt >= now);

    // ⚠️ 渠道判定在**分析阶段**做，不在采集阶段 ——
    //    它依赖当下的就餐方式（到店自取 / 麦乐送 / 团餐），是运行时变量。
    //    采集阶段固化会导致换渠道分析时无法恢复。
    //    若采集阶段已给出结论（appliesToChannel 非 null），优先采信。
    const beTypes = p.beTypes || [];
    const applies =
      p.appliesToChannel !== null && p.appliesToChannel !== undefined
        ? p.appliesToChannel === true
        : beType === null || beTypes.length === 0 || beTypes.includes(beType);

    return {
      id: p.promotionId,
      threshold,
      discount,
      rate,
      rateText: rate ? `${(rate * 100).toFixed(1)}%` : null,
      channelText: p.channelText || "",
      beTypes,
      itemCodes: p.itemCodes || [],
      endAt: p.endAt,
      isLive,
      applies,
    };
  });

  // 生效且适用的规则
  const effective = rules.filter((r) => r.isLive && r.applies);
  // 不适用的（渠道不符）
  const channelMismatch = rules.filter((r) => r.isLive && !r.applies);
  // 已过期
  const expired = rules.filter((r) => !r.isLive);

  // 按门槛分组 —— ⚠️ 同一门槛下有**多条**规则（实测六道口店满 300 有 3 条：减 22/12/7）
  const byTier = new Map();
  for (const r of effective) {
    if (!byTier.has(r.threshold)) byTier.set(r.threshold, []);
    byTier.get(r.threshold).push(r);
  }
  const tiers = [...byTier.entries()]
    .map(([threshold, rs]) => {
      // 叠加可能性：同门槛多条规则**可能**同时生效，但接口不说明是否叠加。
      // 实测在到店场景无法验证（这些规则是团餐专属，calculate-price 减 0）。
      // → 保守按「不叠加」算单条最优，同时给出「若叠加」的乐观值供参考。
      const bestSingle = rs.reduce((a, b) => (b.discount > a.discount ? b : a));
      const sumAll = rs.reduce((s, r) => s + r.discount, 0);
      return {
        threshold,
        rules: rs,
        best: bestSingle,
        bestRate: threshold > 0 ? round(bestSingle.discount / threshold, 4) : null,
        // 若全部叠加的折扣率
        stackedRate: threshold > 0 ? round(sumAll / threshold, 4) : null,
        stackedDiscount: sumAll,
        count: rs.length,
      };
    })
    .sort((a, b) => a.threshold - b.threshold);

  // 最优档：按**单条**折扣率最高（保守口径）
  const best = tiers.length
    ? tiers.reduce((a, b) => ((b.bestRate ?? 0) > (a.bestRate ?? 0) ? b : a))
    : null;

  // 阶梯是否递减：门槛升序时**单条最优**折扣率应单调不增
  let decreasing = true;
  for (let i = 1; i < tiers.length; i++) {
    if ((tiers[i].bestRate ?? 0) > (tiers[i - 1].bestRate ?? 0)) {
      decreasing = false;
      break;
    }
  }

  // 凑到某档门槛的边际代价：门槛 - 减免额
  // 满 300 减 22 → 再花 278 元换 22 元减免，不划算
  const worthIt = effective
    .map((r) => ({
      ...r,
      gapToThreshold: r.threshold,
      netCost: r.threshold - r.discount,
      // 只有当「再花的金额 ≤ 减免额」时凑单才划算（与券的凑单逻辑一致）
      worthwhile: r.threshold - r.discount <= 0,
    }))
    .filter((r) => r.worthwhile);

  return {
    rules,
    effective,
    channelMismatch,
    expired,
    best,
    tiers,
    byThreshold: effective,
    decreasing,
    /** 是否有阶梯递减特征 —— 决定了最优策略是「压最低档」还是「买越多越省」 */
    strategy: decreasing ? "压最低档门槛" : "买越多越省",
    worthIt,
    note: buildNote({ effective, channelMismatch, expired, best, decreasing, beType, tiers }),
  };
}

function buildNote({ effective, channelMismatch, expired, best, decreasing, beType, tiers = [] }) {
  const parts = [];

  if (!effective.length) {
    if (channelMismatch.length) {
      const btName = BE_TYPE_NAMES[beType] || (beType ? `beType${beType}` : "当前渠道");
      const other = [...new Set(channelMismatch.map((r) => r.channelText).filter(Boolean))].join("、");
      parts.push(
        `该店有 ${channelMismatch.length} 条促销规则，但全部是「${other}」渠道的，对${btName}不生效`
      );
    } else {
      parts.push("该店当前没有可用促销规则");
    }
    if (expired.length) parts.push(`另有 ${expired.length} 条已过生效期`);
    return parts.join("；") + "。";
  }

  parts.push(`该店有 ${effective.length} 条当前生效的满额减规则`);

  if (best) {
    parts.push(
      `最优是「满 ${best.threshold} 减 ${best.best.discount}」（${(best.bestRate * 100).toFixed(1)}% off）`
    );
  }
  if (decreasing) {
    parts.push(
      `阶梯是**递减**的 —— 门槛越高折扣率越低，所以最优策略是**刚好压到最低档门槛**，不是买越多越省`
    );
  }
  // 同门槛多条规则：叠加与否接口未说明，如实说明
  const multiTier = tiers.filter((t) => t.count > 1);
  if (multiTier.length) {
    const t = multiTier[0];
    parts.push(
      `注意「满 ${t.threshold}」这一档有 ${t.count} 条规则（减 ${t.rules.map((r) => r.discount).join(" / ")}）` +
        `，接口未说明能否同时生效 —— 上面按**不叠加**算，若可叠加则为减 ${t.stackedDiscount}（${(t.stackedRate * 100).toFixed(1)}% off）`
    );
  }
  if (channelMismatch.length) {
    const other = [...new Set(channelMismatch.map((r) => r.channelText).filter(Boolean))].join("、");
    parts.push(`另有 ${channelMismatch.length} 条「${other}」渠道规则对当前方式不生效`);
  }
  return parts.join("；") + "。";
}

/**
 * 给定一个小计，算出用哪条促销规则最划算。
 *
 * ⚠️ 保守规则：只有在**小计已达到门槛**时才用该规则。
 *    不假设「为了凑单再多买 X 元」—— 那要先问用户愿不愿意多花钱。
 *
 * @param {Array}  rules  analyzePromotionRules 的 effective
 * @param {number} subtotal 当前小计（元）
 */
export function bestPromotionFor(rules = [], subtotal = 0) {
  const s = num(subtotal);
  const applicable = rules.filter((r) => s >= r.threshold);
  if (!applicable.length) {
    // 看看差多少能到最低档
    const lowest = rules.length
      ? rules.reduce((a, b) => (a.threshold <= b.threshold ? a : b))
      : null;
    return {
      applied: null,
      saving: 0,
      reason: lowest
        ? `小计 ¥${s} 还差 ¥${round(lowest.threshold - s)} 到最低档门槛 ¥${lowest.threshold}（减 ¥${lowest.discount}）`
        : "没有可用规则",
      nextTier: lowest,
    };
  }
  // 已达门槛的规则里，选减免额最大的
  const best = applicable.reduce((a, b) => (b.discount > a.discount ? b : a));
  return {
    applied: best,
    saving: best.discount,
    reason: `小计 ¥${s} 已过「满 ${best.threshold} 减 ${best.discount}」门槛，省 ¥${best.discount}`,
    nextTier: null,
  };
}
