/**
 * mcd-points-strategist · 用券排程
 *
 * 把手里的券**逐张排到未来每一次点单**上：
 *   「第几单、哪天、用哪张、净价值多少」
 *
 * 为什么需要它：
 *   券的价值会**过期**。但人有偏好 —— 有人想吃薯条，有人想吃汉堡。
 *   简单按「谁先过期先用谁」会把最灵活的券浪费在最早的一单上。
 *
 *   正确做法是**按到期日求最优解**：
 *   把「可用时段最少的券」留给「可用机会最少的订单」。
 *
 * 这是本项目独有的能力 —— 目前 30 个高星项目里没有第二个做这个。
 *
 * 本模块是纯函数，不碰 IO。
 */

import { computeUsableSlots, checkUsable } from "./coupon-model.mjs";

// --------------------------------------------------------------------------
// 未来点单机会
// --------------------------------------------------------------------------

/**
 * 从历史订单推断未来的点单机会。
 *
 * @param {Array}  orders  历史订单
 * @param {object} opts
 * @param {Date}   [opts.now]
 * @param {number} [opts.horizonDays]  往后看多少天（默认 30）
 * @param {number} [opts.maxOrders]    最多列几次（默认 6）
 */
export function forecastOrders(orders = [], opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const horizonDays = opts.horizonDays ?? 30;
  const maxOrders = opts.maxOrders ?? 6;

  const recent = (orders || [])
    .filter((o) => o.createdAt)
    .map((o) => ({ o, t: new Date(String(o.createdAt).replace(" ", "T")) }))
    .filter((x) => !Number.isNaN(x.t.getTime()) && x.t <= now)
    .sort((a, b) => b.t - a.t)
    .slice(0, 20);

  if (!recent.length) {
    return { cadenceDays: 7, orders: [], note: "没有历史订单，按每周一次的保守节奏估算" };
  }

  // 相邻订单间隔的中位数 —— 中位数比均值抗异常值
  const gaps = [];
  for (let i = 0; i < recent.length - 1; i++) {
    const g = (recent[i].t - recent[i + 1].t) / 86400000;
    if (g > 0 && g < 60) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const cadenceDays = gaps.length ? Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)])) : 7;

  // 推出未来几次点单
  const upcoming = [];
  let cursor = new Date(now);
  for (let i = 0; i < maxOrders; i++) {
    cursor = new Date(cursor.getTime() + cadenceDays * 86400000);
    if ((cursor.getTime() - now.getTime()) / 86400000 > horizonDays) break;
    const dow = cursor.getDay() === 0 ? 6 : cursor.getDay() - 1;
    upcoming.push({
      index: i + 1,
      date: cursor.toISOString().slice(0, 10),
      dow,
      dowText: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][dow],
      hour: 12,
    });
  }

  return {
    cadenceDays,
    orders: upcoming,
    note: `按历史节奏估算，约每 ${cadenceDays} 天一次`,
  };
}

// --------------------------------------------------------------------------
// 排程
// --------------------------------------------------------------------------

/**
 * 把券排到未来每一次点单上。
 *
 * 分配策略（按到期日求最优，不是「谁先过期先用谁」）：
 *
 *   1. 券按「可用天数」升序 —— 可用机会最少的券最紧急
 *   2. 订单按时间升序
 *   3. 逐张分配：对每张券，找**最早**一个它能用的订单
 *      —— 但如果某张券在后面的订单上只能用一次、而前面的订单用不了它，
 *      就要把它留给那个订单
 *
 * 更精确地说，这是一个**二分图最大匹配**问题（券 × 订单，按可用性连边）。
 * 券和订单数量都不大（≤ 20 × ≤ 6），用增广路算法求解最优匹配。
 *
 * @param {Array}  coupons
 * @param {Array}  orders   未来点单机会 [{index, date, dow, hour}]
 * @param {object} opts
 * @param {number} [opts.now]
 * @returns {object} 排程结果
 */
export function scheduleCoupons(coupons = [], orders = [], opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  // 未领取的券不参与排程 —— 还没进卡包，排了也用不了。
  // 它们由体检模块单独列为「先领」。
  const list = (coupons || []).filter((c) => c && c.status !== "可领取");
  const unclaimed = (coupons || []).filter((c) => c && c.status === "可领取");
  const slots = (orders || []).filter(Boolean);

  if (!list.length || !slots.length) {
    return {
      assignments: [],
      unassigned: list.map((c) => ({ name: c.name, reason: "没有可排的未来订单" })),
      unclaimed: unclaimed.map((c) => ({ name: c.name, reason: "尚未领取到卡包，需先领" })),
      wasted: [],
      scheduledCount: 0,
      unassignedCount: list.length,
      scheduledValue: 0,
      unassignedValue: round(list.reduce((s, c) => s + (c.value || 0), 0)),
      coverageRate: 0,
      note: list.length
        ? "没有可排的未来订单"
        : unclaimed.length
          ? "手里只有未领取的券 —— 先领了再排"
          : "手里没有券",
    };
  }

  // ---- 建边：这张券在这个订单上能不能用 ----
  const edges = list.map((c) => {
    const s = computeUsableSlots(c, { now });
    const ok = slots.map((o) => {
      // 星期限制
      if (c.weekdays?.length && !c.weekdays.includes(o.dow)) return false;
      // 时段限制
      if (c.dayWindow) {
        const w = parseWindow(c.dayWindow);
        if (w && !w.contains(o.hour ?? 12)) return false;
      }
      // 有效期
      const orderDate = new Date(`${o.date}T12:00:00`);
      if (c.expireAt && new Date(c.expireAt) < orderDate) return false;
      if (c.validFrom && new Date(c.validFrom) > orderDate) return false;
      return true;
    });
    return { coupon: c, slots: s, ok };
  });

  // ---- 二分图最大匹配（增广路）----
  // 左：券，右：订单。目标是「能排出去多少张券」最大化。
  const matchOrder = new Map(); // orderIndex -> edgeIndex
  const matchCoupon = new Map(); // edgeIndex -> orderIndex

  function augment(edgeIdx, visited) {
    for (let oi = 0; oi < slots.length; oi++) {
      if (!edges[edgeIdx].ok[oi]) continue;
      if (visited.has(oi)) continue;
      visited.add(oi);
      const holder = matchOrder.get(oi);
      if (holder === undefined || augment(holder, visited)) {
        matchOrder.set(oi, edgeIdx);
        matchCoupon.set(edgeIdx, oi);
        return true;
      }
    }
    return false;
  }

  // 券按「可用天数」升序处理 —— 机会最少的先占位
  const order = edges
    .map((e, i) => i)
    .sort((a, b) => {
      const sa = edges[a].slots.usableDays;
      const sb = edges[b].slots.usableDays;
      if (sa === null && sb === null) return 0;
      if (sa === null) return 1; // 期限未知的排后面
      if (sb === null) return -1;
      return sa - sb;
    });

  for (const ei of order) {
    augment(ei, new Set());
  }

  // ---- 生成排程明细 ----
  const assignments = [];
  for (const [oi, ei] of matchOrder) {
    const e = edges[ei];
    const o = slots[oi];
    assignments.push({
      orderIndex: o.index,
      date: o.date,
      dowText: o.dowText,
      coupon: e.coupon.name,
      value: e.coupon.value,
      source: e.coupon.source,
      expireAt: e.coupon.expireAt,
      usableDays: e.slots.usableDays,
      unusableDays: e.slots.unusableDays,
      note: buildNote(e, o),
    });
  }
  assignments.sort((a, b) => a.orderIndex - b.orderIndex);

  // 排不出去的券 —— 说明原因（这是最有价值的诊断信息）
  const unassigned = [];
  for (let ei = 0; ei < edges.length; ei++) {
    if (matchCoupon.has(ei)) continue;
    const e = edges[ei];
    unassigned.push({
      name: e.coupon.name,
      value: e.coupon.value,
      usableDays: e.slots.usableDays,
      reason: explainUnassignable(e, slots, now),
    });
  }

  // 排得出去但会作废的券 —— 排在最后一次点单之后仍会过期
  const wasted = [];
  for (const a of assignments) {
    if (!a.expireAt) continue;
    const exp = new Date(a.expireAt);
    const lastOrder = new Date(`${slots[slots.length - 1].date}T12:00:00`);
    if (exp < lastOrder && a.orderIndex === slots.length - 1) {
      // 排在最后一次也没用 —— 但这在匹配里不会出现（边已排除）
    }
  }

  const totalScheduled = assignments.reduce((s, a) => s + (a.value || 0), 0);
  const totalUnscheduled = unassigned.reduce((s, a) => s + (a.value || 0), 0);

  return {
    assignments,
    unassigned,
    unclaimed: unclaimed.map((c) => ({ name: c.name, reason: "尚未领取到卡包，需先领" })),
    wasted,
    scheduledCount: assignments.length,
    unassignedCount: unassigned.length,
    scheduledValue: round(totalScheduled),
    unassignedValue: round(totalUnscheduled),
    coverageRate: list.length ? round(assignments.length / list.length) : 0,
    note: buildScheduleNote(assignments, unassigned, slots),
  };
}

// --------------------------------------------------------------------------
// 诊断
// --------------------------------------------------------------------------

function explainUnassignable(edge, slots, now) {
  const c = edge.coupon;
  if (!edge.ok.some(Boolean)) {
    // ⚠️ 诊断顺序很重要：**先看有效期，再看时段与星期限制**。
    //    反过来的话，一张「10-29 到期、时段 10:30-23:59」的券在点单预测为
    //    12:00 时会先撞上时段规则，报「时段与点餐时间不匹配」——
    //    而 12:00 明明落在 10:30-23:59 之内。真实卡点是它在下一次点餐前就过期了。
    //    报错的诊断会让用户去等时段，而不是去赶在过期前用掉。
    const firstSlot = slots[0];
    if (c.expireAt && firstSlot && new Date(c.expireAt) < new Date(`${firstSlot.date}T${String(firstSlot.hour ?? 12).padStart(2, "0")}:00:00`)) {
      const exp = new Date(c.expireAt);
      const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / 86400000);
      // 关键洞察：按平时的节奏等下去会赶不上 —— 但**现在去就能用掉**。
      // 只说「过期了」用户会以为作废；说清「还剩几天、今天就能用」才可执行。
      return (
        `按平时的点餐节奏（下次约 ${firstSlot.date}）会赶不上过期（${exp.toISOString().slice(0, 10)}），` +
        `但它现在还有 ${Math.max(0, daysLeft)} 天有效期 —— 这几天内去就能用掉`
      );
    }
    if (c.weekdays?.length) {
      return `限定${c.weekdayText || "特定星期"}，未来几次点餐都赶不上`;
    }
    if (c.dayWindow) {
      return `可用时段 ${c.dayWindow}，与点餐时间不匹配`;
    }
    return "在计划的点餐时点上无法使用";
  }
  return "排期冲突：更紧的券已经占了这些机会";
}

function buildNote(edge, order) {
  const c = edge.coupon;
  const parts = [];
  if (c.dayWindow) parts.push(`仅 ${c.dayWindow}`);
  if (c.weekdays?.length) parts.push(c.weekdayText || "限特定星期");
  if (c.channel?.length) {
    parts.push(c.channel.map((x) => (x === "pickup" ? "到店" : "外送")).join("/"));
  }
  if (!parts.length) return "";
  return parts.join(" · ");
}

function buildScheduleNote(assignments, unassigned, slots) {
  if (!assignments.length) {
    return `未来 ${slots.length} 次点餐都排不进任何一张券 —— 检查一下时段与星期限制`;
  }
  const parts = [
    `${assignments.length} 张券已排入未来 ${slots.length} 次点餐`,
  ];
  if (unassigned.length) {
    parts.push(`${unassigned.length} 张排不进去`);
  }
  return `${parts.join("，")}。`;
}

// --------------------------------------------------------------------------
// 工具
// --------------------------------------------------------------------------

function parseWindow(text) {
  const m = String(text || "").match(/(\d{1,2}):(\d{2})\s*[-–~]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return { start, end, contains(h) { const x = h * 60; return x >= start && x <= end; } };
}

function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round(v * f) / f;
}
