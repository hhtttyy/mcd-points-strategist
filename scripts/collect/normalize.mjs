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
  // ⚠️ 同时输出**新旧两套字段名**。
  //    新契约用 available/accumulative/used/expired，
  //    而 `points-engine.mjs`（浏览器 Demo 与早期 CLI 共用）读的是
  //    availablePoint/accumulativePoint/expiredPoint。
  //    只输出新名会让 Demo 的「累计获得 / 已过期 / 衰减率」全部显示 0。
  //    兼容层做桥接，两套命名都能工作。
  const available = num(a.available ?? a.availablePoint);
  const accumulative = num(a.accumulative ?? a.accumulativePoint);
  const used = num(a.used ?? a.usedPoint);
  const expired = num(a.expired ?? a.expiredPoint);
  const frozen = num(a.frozen ?? a.frozenPoint);
  const expiringThisMonth = num(a.expiringThisMonth ?? a.currentMouthExpirePoint);
  const expiringNextMonth = num(a.expiringNextMonth ?? a.nextMouthExpirePoint);
  return {
    // 新契约
    available,
    accumulative,
    used,
    expired,
    frozen,
    expiringThisMonth,
    expiringNextMonth,
    // 旧契约（points-engine.mjs 读这套）
    availablePoint: available,
    accumulativePoint: accumulative,
    usedPoint: used,
    expiredPoint: expired,
    frozenPoint: frozen,
    currentMouthExpirePoint: expiringThisMonth,
    nextMouthExpirePoint: expiringNextMonth,
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
      beCode: s.beCode ?? "",
      businessStartTime: s.businessStartTime ?? "",
      businessEndTime: s.businessEndTime ?? "",
      businessStatus: s.businessStatus ?? null,
      reservation: s.reservation === true,
    })),
    // 促销：保留结构化规则字段（threshold/discount/rate/beTypes）——
    // 早期快照只有 title/description，规则字段为 undefined，
    // promotion-rules 模块会自动判定为「无可用规则」而不是编造。
    promotions: (snap.promotions || []).map((p) => ({
      ...p,
      promotionId: p.promotionId ?? "",
      rule: p.rule ?? "unknown",
      threshold: num(p.threshold),
      discount: num(p.discount),
      rate: p.rate ?? null,
      beTypes: Array.isArray(p.beTypes) ? p.beTypes : [],
      channelText: p.channelText ?? "",
      itemCodes: Array.isArray(p.itemCodes) ? p.itemCodes : [],
      startAt: p.startAt ?? null,
      endAt: p.endAt ?? null,
      isLive: p.isLive !== false,
      // ⚠️ 必须保留 null —— 渠道判定在**分析阶段**做（它依赖运行时就餐方式）。
      //    `p.appliesToChannel !== false` 会把 null 变成 true，
      //    导致「渠道待定」被误当成「渠道适用」——
      //    实测这会让到店场景误报「12 条满额减生效中」（实际全是团餐的）。
      appliesToChannel:
        p.appliesToChannel === true ? true : p.appliesToChannel === false ? false : null,
      title: p.title ?? "",
      description: p.description ?? "",
    })),
    storeCode: snap.storeCode ?? null,
    // 门店实时菜单
    menu: (snap.menu || []).map((m) => ({
      code: String(m.code ?? ""),
      name: m.name ?? "",
      currentPrice: num(m.currentPrice),
      originalPrice: num(m.originalPrice),
      ownSaving: num(m.ownSaving),
      discountType: m.discountType ?? null,
      canWithOrder: m.canWithOrder === true,
      category: m.category ?? "",
      tags: Array.isArray(m.tags) ? m.tags : [],
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
