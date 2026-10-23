/**
 * mcd-points-strategist · 快照归一化
 *
 * 把不同版本的快照统一到**当前契约**。
 *
 * 为什么需要：项目早期的 `fixtures/mcd-snapshot.json` 用的是旧字段名
 * （`title` / `spuName` / `availablePoint`），M1 之后契约改成了
 * （`name` / `name` / `available`）。Demo 页面读的是旧快照，
 * 引擎读的是新契约 —— 这里做一层桥接，两边都能跑。
 *
 * 本模块是纯函数，不碰 IO。
 */

import {
  parseChannel,
  parseDayWindow,
  parseExpireAt,
  parseValidFrom,
  parseWeekdays,
  toIso,
} from "./parse.mjs";

/**
 * 券：title → name
 *
 * 早期快照只存了 `expireText`（有效期原文）与 `labelText`（渠道标签），
 * 这里把它们解析成结构化字段 —— 否则券引擎拿不到时段/星期/渠道限制，
 * 「还剩几天」与「真正能用几天」就分不出来。
 */
function normalizeCoupon(c) {
  if (!c) return c;
  const expireText = c.expireText ?? c.expire_text ?? "";
  const labelText = c.labelText ?? c.label ?? c.channel_tags ?? "";

  return {
    ...c,
    name: c.name ?? c.title ?? "",
    value: num(c.value ?? c.faceValue),
    threshold: num(c.threshold),
    expireAt: c.expireAt ?? (expireText ? toIso(parseExpireAt(expireText)) : null),
    expireText,
    dayWindow: c.dayWindow ?? parseDayWindow(expireText),
    weekdays: Array.isArray(c.weekdays) ? c.weekdays : parseWeekdays(expireText),
    weekdayText: c.weekdayText ?? (expireText.match(/周[一二三四五六日天、,，\s]*/) || [""])[0].trim(),
    channel: Array.isArray(c.channel) ? c.channel : parseChannel(labelText),
    validFrom: c.validFrom ?? (expireText ? toIso(parseValidFrom(expireText)) : null),
    source: c.source ?? "mcd-savers",
    status: c.status ?? "已领取",
    itemCodes: Array.isArray(c.itemCodes) ? c.itemCodes : [],
    stackable: c.stackable === true,
    type: c.type ?? "threshold",
  };
}

/** 商城：spuName → name, point → points, catName → category */
function normalizeMallItem(m) {
  if (!m) return m;
  return {
    ...m,
    name: m.name ?? m.spuName ?? "",
    points: num(m.points ?? m.point),
    faceValue: num(m.faceValue),
    faceValueSource: m.faceValueSource ?? "unknown",
    category: m.category ?? m.catName ?? "",
    shopId: num(m.shopId),
    upAt: m.upAt ?? m.upTime ?? null,
    downAt: m.downAt ?? m.downTime ?? null,
    status: m.status ?? "live",
    imageUrl: m.imageUrl ?? "",
  };
}

/** 积分账户：availablePoint → available 等 */
function normalizeAccount(a) {
  if (!a) return null;
  return {
    available: num(a.available ?? a.availablePoint),
    accumulative: num(a.accumulative ?? a.accumulativePoint),
    used: num(a.used ?? a.usedPoint),
    expired: num(a.expired ?? a.expiredPoint),
    frozen: num(a.frozen ?? a.frozenPoint),
    expiringThisMonth: num(a.expiringThisMonth ?? a.currentMouthExpirePoint),
    expiringNextMonth: num(a.expiringNextMonth ?? a.nextMouthExpirePoint),
    currency: a.currency || "麦享会积分",
  };
}

/** 订单：realTotalAmount → amount */
function normalizeOrder(o) {
  if (!o) return o;
  return {
    ...o,
    orderId: String(o.orderId ?? ""),
    createdAt: String(o.createdAt ?? o.createTime ?? ""),
    storeCode: String(o.storeCode ?? ""),
    storeName: String(o.storeName ?? ""),
    status: String(o.status ?? o.orderStatus ?? ""),
    amount: num(o.amount ?? o.realTotalAmount),
    items: Array.isArray(o.items) ? o.items : [],
  };
}

/**
 * 归一化整份快照。
 *
 * 已经是当前契约的字段会被原样保留（幂等）。
 */
export function normalizeSnapshot(snap) {
  if (!snap) return snap;
  return {
    ...snap,
    generatedAt: snap.generatedAt ?? snap._generatedAt ?? null,
    source: snap.source ?? snap._source ?? "",
    account: normalizeAccount(snap.account),
    mall: (snap.mall || []).map(normalizeMallItem),
    coupons: (snap.coupons || []).map(normalizeCoupon),
    campaigns: (snap.campaigns || []).map((c) => ({
      date: c.date ?? "",
      phase: c.phase ?? "",
      titles: Array.isArray(c.titles) ? c.titles : c.title ? [c.title] : [],
      highlights: c.highlights ?? "",
    })),
    lottery: snap.lottery ?? null,
    orders: (snap.orders || []).map(normalizeOrder),
    stores: (snap.stores || []).map((s) => ({
      storeCode: String(s.storeCode ?? ""),
      name: s.name ?? "",
      address: s.address ?? "",
      distance: s.distance ?? null,
    })),
    promotions: (snap.promotions || []).map((p) => ({
      title: p.title ?? "",
      description: p.description ?? "",
    })),
    errors: (snap.errors || []).map((e) => ({
      tool: e.tool ?? "",
      error: e.error ?? "",
    })),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
