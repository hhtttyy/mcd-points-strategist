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

  const totalValue = round(
    list.reduce((s, c) => s + (c.value > 0 ? c.value : 0), 0)
  );

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

  const expiredValue = round(expired.reduce((s, e) => s + (e.coupon.value || 0), 0));
  const todayValue = round(todayDue.reduce((s, e) => s + (e.coupon.value || 0), 0));
  const upcomingValue = round(upcoming.reduce((s, e) => s + (e.coupon.value || 0), 0));
  const atRiskValue = round(expiredValue + todayValue + upcomingValue);

  // 面值无法确定的券同样在过期，只是金额算不出来 —— 必须说出来，
  // 否则「面值 X 元」会被读成「全部损失只有 X 元」
  const unknownCount = atRisk.filter((e) => !(e.coupon.value > 0)).length;

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
      `${expired.length} 张已经过期（面值 ${expiredValue} 元），这部分钱已经扔掉了`
    );
  }
  if (todayDue.length) {
    parts.push(`${todayDue.length} 张今天到期（面值 ${todayValue} 元），今天不用就作废`);
  }
  if (upcoming.length) {
    parts.push(
      `${upcoming.length} 张将在 ${daysMax} 天内陆续过期（面值 ${upcomingValue} 元）`
    );
  }
  if (unknownCount) {
    parts.push(`另有 ${unknownCount} 张的券面价值无法从菜单推算，未计入面值`);
  }

  let narrative;
  if (!list.length) {
    narrative = "你目前手里没有可用的券。";
  } else if (parts.length) {
    narrative = `你的券有风险：${parts.join("；")}。`;
  } else {
    narrative = `你手里有 ${list.length} 张券，面值合计 ${totalValue} 元，近期没有即将过期的，可以放心。`;
  }

  return {
    totalValue,
    atRiskValue,
    atRiskCount: atRisk.length,
    expiredCount: expired.length,
    todayDueCount: todayDue.length,
    upcomingCount: upcoming.length,
    unknownCount,
    atRiskItems: atRisk.map((e) => ({
      name: e.coupon.name,
      value: e.coupon.value,
      expireAt: e.coupon.expireAt,
      daysLeft: e.slots.expired
        ? Math.ceil((new Date(e.coupon.expireAt).getTime() - now.getTime()) / 86400000)
        : Math.ceil((new Date(e.coupon.expireAt).getTime() - now.getTime()) / 86400000),
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
    const withValue = group.filter((c) => c.value > 0);
    if (withValue.length < 2) continue;

    const cheapest = withValue.reduce((a, b) => (a.value <= b.value ? a : b));
    const dearest = withValue.reduce((a, b) => (a.value >= b.value ? a : b));
    if (dearest.value > cheapest.value) {
      found.push({
        name,
        cheapest: { value: cheapest.value, id: cheapest.id, source: cheapest.source },
        dearest: { value: dearest.value, id: dearest.id, source: dearest.source },
        waste: round(dearest.value - cheapest.value),
      });
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
