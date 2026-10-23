/**
 * mcd-points-strategist · 券体检与沉默成本
 *
 * 券的沉默成本 —— 本项目最核心的差异化指标：
 *
 *   ┌────────────────────────────────────────────┐
 *   │  你手里有 13 张券，其中 5 张将在 7 天内过期  │
 *   │  若未使用，将白白损失 ¥47.5                 │
 *   └────────────────────────────────────────────┘
 *
 * 这个数字可量化、够扎心，而且**用户通常毫无察觉**。
 *
 * 但本模块比「算过期金额」多做三件事：
 *   1. 区分「已过期」「今天到期」「N 天内过期」—— 三种紧迫度完全不同
 *   2. 报**真正还能用几天**，而不是剩余日历天数
 *   3. 识别「同款不同价」—— 换贵的那个等于白扔积分
 *
 * 本模块是纯函数，不碰 IO。
 */

import { computeUsableSlots, checkUsable } from "./coupon-model.mjs";

// --------------------------------------------------------------------------
// 沉默成本
// --------------------------------------------------------------------------

/**
 * 计算券的沉默成本。
 *
 * @param {Array}  coupons
 * @param {object} opts
 * @param {Date}   [opts.now]
 * @param {number} [opts.expiringWithin] 多久内算「有风险」（默认 7 天）
 * @param {string} [opts.channel]        当前就餐方式，用于判断券能不能用
 * @param {number} [opts.hour]           当前小时，用于时段判定
 */
export function computeSilentCost(coupons = [], opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const within = opts.expiringWithin ?? 7;
  const list = (coupons || []).filter(Boolean);

  // ⚠️ 一律用 `benefit`（可确证的优惠金额）而不是 `value`（接口原样数字）。
  //    coupon_price 语义的券（用券价格 = 你付的钱）benefit 为 null ——
  //    把「到手价 20.48」当成「省了 20.48」是彻底的反向错误。
  //
  //    benefit 由 decorateCoupon 计算；但本函数可能被直接传入未装饰的裸对象，
  //    所以这里做一次兜底推导：没有 benefitKnown 字段时，按 discount_amount 语义处理。
  const isBenefitKnown = (c) =>
    c.benefitKnown !== undefined
      ? c.benefitKnown === true
      : c.valueKind !== "coupon_price" && Number(c.value) > 0;
  const benefitOf = (c) => (isBenefitKnown(c) ? Number(c.value) || 0 : 0);

  const totalValue = round(list.reduce((s, c) => s + benefitOf(c), 0));
  const priceOnlyCount = list.filter(
    (c) => !isBenefitKnown(c) && (c.value > 0 || c.valueKind === "coupon_price")
  ).length;

  const enriched = list.map((c) => {
    const slots = computeUsableSlots(c, { now });
    const usable = checkUsable(c, {
      at: now.toISOString(),
      channel: opts.channel,
      hour: opts.hour,
    });
    return { coupon: c, slots, usable, daysLeft: c.daysLeft ?? slots.usableDays };
  });

  // 风险判定：距过期不足 within 天（含已过期）
  const atRisk = enriched.filter((e) => {
    if (e.coupon.expireAt) {
      const d = new Date(e.coupon.expireAt);
      const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      return diff <= within;
    }
    return false;
  });

  // 紧迫度排序：已过期 → 今天到期 → 越近越前
  atRisk.sort((a, b) => {
    const da = a.coupon.expireAt ? new Date(a.coupon.expireAt).getTime() : Infinity;
    const db = b.coupon.expireAt ? new Date(b.coupon.expireAt).getTime() : Infinity;
    return da - db;
  });

  const expired = atRisk.filter((e) => new Date(e.coupon.expireAt) < now);
  const todayDue = atRisk.filter((e) => {
    const d = new Date(e.coupon.expireAt);
    return d >= now && d.getTime() - now.getTime() < 86400000;
  });
  const upcoming = atRisk.filter((e) => {
    const d = new Date(e.coupon.expireAt);
    return d.getTime() - now.getTime() >= 86400000;
  });

  const expiredValue = round(expired.reduce((s, e) => s + benefitOf(e.coupon), 0));
  const todayValue = round(todayDue.reduce((s, e) => s + benefitOf(e.coupon), 0));
  const upcomingValue = round(upcoming.reduce((s, e) => s + benefitOf(e.coupon), 0));
  const atRiskValue = round(expiredValue + todayValue + upcomingValue);

  // 面值无法确定的券同样在过期，只是金额算不出来 —— 必须说出来，
  // 否则「面值 X 元」会被读成「全部损失只有 X 元」
  const unknownCount = atRisk.filter((e) => !isBenefitKnown(e.coupon)).length;

  // 「N 天内」取窗口上限：9 张券散布在 1~7 天时，
  // 写「1 天内」会让人误以为全部明天就没了，「7 天内」才是准确的紧迫度上界
  const daysMax = upcoming.length
    ? Math.max(
        ...upcoming.map(
          (e) => Math.ceil((new Date(e.coupon.expireAt).getTime() - now.getTime()) / 86400000)
        )
      )
    : 0;

  const parts = [];
  if (expired.length) {
    parts.push(
      `${expired.length} 张已经过期（可确证优惠 ${expiredValue} 元），这部分钱已经扔掉了`
    );
  }
  if (todayDue.length) {
    parts.push(`${todayDue.length} 张今天到期（可确证优惠 ${todayValue} 元），今天不用就作废`);
  }
  if (upcoming.length) {
    parts.push(
      `${upcoming.length} 张将在 ${daysMax} 天内陆续过期（可确证优惠 ${upcomingValue} 元）`
    );
  }
  if (unknownCount) {
    parts.push(`另有 ${unknownCount} 张只能看到「用券价格」，无法推算实际优惠额，未计入金额`);
  }

  let narrative;
  if (!list.length) {
    narrative = "你目前手里没有可用的券。";
  } else if (parts.length) {
    narrative = `你的券有风险：${parts.join("；")}。`;
  } else {
    narrative = `你手里有 ${list.length} 张券，可确证优惠合计 ${totalValue} 元，近期没有即将过期的，可以放心。`;
  }

  return {
    totalValue,
    atRiskValue,
    atRiskCount: atRisk.length,
    expiredCount: expired.length,
    todayDueCount: todayDue.length,
    upcomingCount: upcoming.length,
    unknownCount,
    priceOnlyCount,
    atRiskItems: atRisk.map((e) => ({
      id: e.coupon.id,
      code: e.coupon.code,
      name: e.coupon.name,
      value: e.coupon.value,
      benefit: e.coupon.benefit,
      benefitKnown: e.coupon.benefitKnown,
      valueKind: e.coupon.valueKind,
      valueDesc: e.coupon.valueDesc,
      expireAt: e.coupon.expireAt,
      daysLeft: Math.ceil((new Date(e.coupon.expireAt).getTime() - now.getTime()) / 86400000),
      usableDays: e.slots.usableDays,
      unusableDays: e.slots.unusableDays,
      dayWindow: e.coupon.dayWindow,
      weekdayText: e.coupon.weekdayText,
      channel: e.coupon.channel,
      source: e.coupon.source,
      usableNow: e.usable.ok,
      unusableReason: e.usable.reason,
    })),
    narrative,
  };
}

// --------------------------------------------------------------------------
// 同款不同价
// --------------------------------------------------------------------------

/**
 * 找出**同名但券面价值不同**的券。
 *
 * 实测确实存在：「10.9元指定小食任选」有两个 SPU，
 * 一个要 200 积分、一个只要 100 积分 —— 换贵的那个等于白扔 100 积分。
 *
 * 对券而言同理：同名的券若面额不同，应换便宜的。
 */
export function findDuplicateTiers(coupons = []) {
  const byName = new Map();
  for (const c of coupons) {
    const key = c.name;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }

  const found = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    // 只比较**语义可比**的数字：
    //   discount_amount 语义的 value 是「省多少」→ 小的更差
    //   coupon_price 语义的 value 是「付多少」→ 小的更好
    // 两种语义混在一起比较会得出完全相反的结论，因此按 valueKind 分组。
    const byKind = new Map();
    for (const c of group) {
      if (!(c.value > 0)) continue;
      const k = c.valueKind || "discount_amount";
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(c);
    }

    for (const [kind, items] of byKind) {
      if (items.length < 2) continue;
      const cheapest = items.reduce((a, b) => (a.value <= b.value ? a : b));
      const dearest = items.reduce((a, b) => (a.value >= b.value ? a : b));
      if (dearest.value > cheapest.value) {
        // coupon_price（用券价格）：付得少才是好的 → 浪费额 = 最贵 - 最便宜
        // discount_amount（减免金额）：省得多才是好的 → 浪费额 = 最少 - 最多
        const waste = kind === "coupon_price"
          ? round(dearest.value - cheapest.value)
          : round(dearest.value - cheapest.value);
        found.push({
          name,
          valueKind: kind,
          cheaper: { value: cheapest.value, id: cheapest.id, source: cheapest.source },
          pricier: { value: dearest.value, id: dearest.id, source: dearest.source },
          waste,
          advice:
            kind === "coupon_price"
              ? `同款券里「${cheapest.source}」的到手价只要 ¥${cheapest.value}，换它能多省 ¥${waste}`
              : `同款券里「${dearest.source}」的减免额是 ¥${dearest.value}，比「${cheapest.source}」多 ${waste}`,
        });
      }
    }
  }
  found.sort((a, b) => b.waste - a.waste);
  return found;
}

// --------------------------------------------------------------------------
// 券体检
// --------------------------------------------------------------------------

/**
 * 对整个券包做一次体检。
 *
 * 回答四个问题：
 *   1. 我有多少券值多少钱？哪些在白白过期？
 *   2. 哪些券现在根本用不了（时段/星期/渠道不对）？
 *   3. 有没有同款不同价（换便宜的那个）？
 *   4. 有没有未领取但快下架的（先领）？
 */
export function auditCoupons(coupons = [], opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const list = (coupons || []).filter(Boolean);

  const silent = computeSilentCost(list, { ...opts, now });

  // 当前用不了的券
  const unusable = list
    .map((c) => ({ coupon: c, check: checkUsable(c, { at: now.toISOString(), channel: opts.channel, hour: opts.hour }) }))
    .filter((x) => !x.check.ok && x.coupon.expireAt && new Date(x.coupon.expireAt) > now)
    .map((x) => ({
      name: x.coupon.name,
      reason: x.check.reason,
      dayWindow: x.coupon.dayWindow,
      weekdayText: x.coupon.weekdayText,
      channel: x.coupon.channel,
      expireAt: x.coupon.expireAt,
      value: x.coupon.value,
    }));

  // 未领取的（可领但还没领）
  const unclaimed = list
    .filter((c) => c.status === "可领取")
    .map((c) => ({ name: c.name, source: c.source, value: c.value }));

  const duplicates = findDuplicateTiers(list);

  // 可用时段统计
  const slots = list.map((c) => {
    const s = computeUsableSlots(c, { now });
    return { name: c.name, ...s };
  });
  const withSlots = slots.filter((s) => s.usableDays !== null);
  const avgUsable = withSlots.length
    ? round(withSlots.reduce((s, x) => s + x.usableDays, 0) / withSlots.length)
    : null;

  return {
    total: list.length,
    totalValue: silent.totalValue,
    silent,
    unusable,
    unclaimed,
    duplicates,
    slots,
    avgUsableDays: avgUsable,
    narrative: buildNarrative({ silent, unusable, unclaimed, duplicates, total: list.length }),
  };
}

/**
 * 生成一句话结论。
 */
function buildNarrative({ silent, unusable, unclaimed, duplicates, total }) {
  const parts = [];
  if (total) {
    parts.push(`你手里有 ${total} 张券`);
  } else {
    return "你目前手里没有可用的券。";
  }

  if (silent.atRiskCount) {
    parts.push(`其中 ${silent.atRiskCount} 张有过期风险，涉及面值 ¥${silent.atRiskValue}`);
  } else {
    parts.push("近期没有即将过期的");
  }

  if (unclaimed.length) {
    parts.push(`另有 ${unclaimed.length} 张可领未领`);
  }
  if (unusable.length) {
    parts.push(`${unusable.length} 张当前时段或渠道用不了`);
  }
  if (duplicates.length) {
    parts.push(`${duplicates.length} 组同款不同价，换便宜的可省 ¥${duplicates[0].waste}`);
  }

  return `${parts.join("，")}。`;
}

// --------------------------------------------------------------------------
// 工具
// --------------------------------------------------------------------------

function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round(v * f) / f;
}
