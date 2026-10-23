/**
 * mcd-points-strategist · 资产采集器
 *
 * 每个函数都是纯函数：(MCP 原始响应) => 契约对象。
 * 不发起网络请求 —— 网络由 app 层通过 MCP 工具发起，结果传进来。
 *
 * 这样拆分的目的：采集逻辑可离线测试（用 fixtures），且不与 IO 耦合。
 */

import {
  collectAvailableCouponsJson,
  collectCampaignsJson,
  collectMallItems,
  collectMyCouponsJson,
  collectOrders,
  collectStoreCouponsJson,
  collectStoresJson,
  decorateCoupon,
  num,
  parseCampaignsMarkdown,
  parseChannel,
  parseCouponListMarkdown,
  parseDayWindow,
  parseExpireAt,
  parseMyCouponsMarkdown,
  parseValidFrom,
  parseWeekdays,
  toIso,
} from "./parse.mjs";

export { collectOrders };

// --------------------------------------------------------------------------
// 积分账户
// --------------------------------------------------------------------------

/**
 * `query-my-account` → PointsAccount
 *
 * 实测字段：availablePoint / accumulativePoint / usedPoint / expiredPoint /
 *         frozenPoint / currentMouthExpirePoint / nextMouthExpirePoint
 */
export function collectAccount(data) {
  const d = data?.data || data || {};
  return {
    available: num(d.availablePoint),
    accumulative: num(d.accumulativePoint),
    used: num(d.usedPoint),
    expired: num(d.expiredPoint),
    frozen: num(d.frozenPoint),
    expiringThisMonth: num(d.currentMouthExpirePoint),
    expiringNextMonth: num(d.nextMouthExpirePoint),
    currency: String(d.currency || "麦享会积分"),
  };
}

// --------------------------------------------------------------------------
// 积分商城
// --------------------------------------------------------------------------

/** `mall-points-products` → MallItem[] */
export function collectMall(data, opts = {}) {
  return collectMallItems(data, opts);
}

/**
 * `mall-product-detail` → 单个 MallItem（补齐兑换期等信息）。
 *
 * 商城列表里的 `downTime` 可能是粗粒度时间，逐个 SPU 查详情能拿到更准的截止日。
 */
export function collectMallDetail(data, { now = new Date() } = {}) {
  const d = data?.data || data || {};
  const list = collectMallItems([d], { now });
  return list[0] || null;
}

// --------------------------------------------------------------------------
// 优惠券
// --------------------------------------------------------------------------

/**
 * `available-coupons` → 麦麦省可领券列表。
 *
 * ⚠️ 该工具**不接受任何参数**，返回的是**账户全域**的麦麦省券，
 *    不限于某个门店。这就是「先领券、再核实门店细节」能成立的原因：
 *    领券这一动作与门店无关，不需要先定位门店。
 *
 * ⚠️ 实测（2026-10-23 真实调用）返回的是**业务 JSON 直挂顶层**：
 *    `{ success, code, data: [ { couponName, couponImage, couponStatus, label } ] }`
 *    —— 不是标准 MCP 的 `{ content: [...] }` 信封。
 *    早期基于脱敏 Markdown fixture 写的正则路径保留，作为回退。
 */
export function collectAvailableCoupons(raw, { now = new Date() } = {}) {
  const fromJson = collectAvailableCouponsJson(raw);
  const rows = fromJson.length
    ? fromJson
    : parseCouponListMarkdown(raw).map((r) => ({
        name: r.name,
        status: r.status,
        value: 0,
        imageUrl: "",
        labelText: "",
      }));

  return rows.map((r, i) =>
    decorateCoupon(
      {
        id: r.id || `mcd-savers-${i}-${r.name}`,
        name: r.name,
        value: num(r.value),
        threshold: 0,
        expireAt: null,
        expireText: "",
        dayWindow: "",
        weekdays: [],
        weekdayText: "",
        channel: r.channel || [],
        validFrom: null,
        source: "mcd-savers",
        status: r.status,
        imageUrl: r.imageUrl || "",
        labelText: r.labelText || "",
        itemCodes: [],
        stackable: false,
        usableSlots: null,
      },
      { now }
    )
  );
}

/**
 * `query-my-coupons` → 卡包中持有的券（含完整有效期与限制）。
 *
 * 这是**唯一能拿到券有效期与限制的来源**。未领取的券拿不到这些字段，
 * 因此对「可领取」的券只能给出「未知」而不能编造剩余天数。
 *
 * ⚠️ 实测返回 `{ data: { coupons: [...] } }`，业务 JSON 直挂顶层。
 *    时段/星期/渠道/有效期全是原生字段，无需从文本正则抠。
 */
export function collectMyCoupons(raw, { now = new Date() } = {}) {
  const fromJson = collectMyCouponsJson(raw);
  const rows = fromJson.length
    ? fromJson
    : parseMyCouponsMarkdown(raw).map((r) => ({
        id: "",
        code: "",
        name: r.name,
        value: r.value,
        valueDesc: "",
        valueKind: "discount_amount",
        expireAt: r.expireAt,
        validFrom: toIso(parseValidFrom(r.expireText)),
        expireText: r.expireText,
        dayWindow: r.dayWindow,
        dayWindows: r.dayWindow ? [r.dayWindow] : [],
        weekdays: r.weekdays,
        weekdayText: r.weekdayText,
        channel: r.channel,
        labelText: r.labelText,
        receivedText: r.receivedText,
      }));

  return rows.map((r, i) =>
    decorateCoupon(
      {
        id: r.id || `my-${i}-${r.name}`,
        code: r.code || "",
        name: r.name,
        value: num(r.value),
        valueDesc: r.valueDesc || "",
        valueKind: r.valueKind || "discount_amount",
        threshold: 0,
        expireAt: r.expireAt,
        expireText: r.expireText,
        dayWindow: r.dayWindow,
        dayWindows: r.dayWindows || [],
        weekdays: r.weekdays,
        weekdayText: r.weekdayText,
        channel: r.channel,
        validFrom: r.validFrom,
        source: "my",
        status: "已领取",
        labelText: r.labelText || "",
        receivedText: r.receivedText || "",
        itemCodes: [],
        stackable: false,
        usableSlots: null,
      },
      { now }
    )
  );
}

/**
 * `query-store-coupons` → 门店专属券。
 *
 * 需要 storeCode。返回的是该门店**当前可用**的券，口径比卡包窄 ——
 * 实测某用户卡包 9 张，同一时刻该门店只认 2 张。两者必须都拉。
 *
 * ⚠️ 实测返回 `{ data: [{ title, couponId, couponCode, tradeDateTime, products }] }`，
 *    业务 JSON 直挂顶层。
 */
export function collectStoreCoupons(raw, { now = new Date() } = {}) {
  const fromJson = collectStoreCouponsJson(raw);
  const rows = fromJson.length
    ? fromJson
    : parseMyCouponsMarkdown(raw).map((r) => ({
        id: "",
        code: "",
        name: r.name,
        value: r.value,
        valueDesc: "",
        valueKind: "discount_amount",
        expireAt: r.expireAt,
        validFrom: toIso(parseValidFrom(r.expireText)),
        expireText: r.expireText,
        dayWindow: r.dayWindow,
        dayWindows: r.dayWindow ? [r.dayWindow] : [],
        weekdays: r.weekdays,
        weekdayText: r.weekdayText,
        channel: r.channel,
        labelText: r.labelText,
        itemCodes: [],
      }));

  return rows.map((r, i) =>
    decorateCoupon(
      {
        id: r.id || `store-${i}-${r.name}`,
        code: r.code || "",
        name: r.name,
        value: num(r.value),
        valueDesc: r.valueDesc || "",
        valueKind: r.valueKind || "discount_amount",
        threshold: 0,
        expireAt: r.expireAt,
        expireText: r.expireText,
        dayWindow: r.dayWindow,
        dayWindows: r.dayWindows || [],
        weekdays: r.weekdays,
        weekdayText: r.weekdayText,
        channel: r.channel,
        validFrom: r.validFrom,
        source: "store",
        status: "门店可用",
        labelText: r.labelText || "",
        itemCodes: r.itemCodes || [],
        stackable: false,
        usableSlots: null,
      },
      { now }
    )
  );
}

/**
 * 合并三路券源，去重。
 *
 * 三个来源的视角不同，**不能只查一个**：
 *   - mcd-savers：麦麦省可领券（账户全域，与门店无关）
 *   - my        ：卡包持有券（账户级，含有效期）
 *   - store     ：门店可用券（门店级，口径最窄）
 *
 * ⚠️ 去重键必须用**结构化的到期时刻** `expireAt`，不能用有效期原文。
 *    实测（2026-10-23）：同一张券在卡包与门店两路的原文格式不同 ——
 *      卡包：tradeEndDateTime       → "2026-10-29 23:59:59"
 *      门店：tradeDateTime（区间）   → "2026-10-23 00:00:00-2026-10-29 23:59:59"
 *    用原文做键 → 同一张券被算成两张，看板上会出现两条一模一样的券。
 *    用 expireAt（归一化后的 ISO 时刻）→ 正确合并。
 *
 * ⚠️ 也不能用 couponId 去重：实测同一张券两次拉取的 couponId 可能不同
 *    （卡包用 id，门店用 couponId，值恰好一致但语义不同源）。
 */
export function mergeCoupons(sources, { now = new Date() } = {}) {
  const all = sources.flat().filter(Boolean);
  const byKey = new Map();
  for (const c of all) {
    // 键：券名 + 归一化到期时刻（无到期时刻的券按名称独立计数）
    const key = `${c.name}|${c.expireAt || "no-expire"}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
      continue;
    }
    // 已存在同名同期的券：保留信息更全的（字段更非空）
    const score = (x) =>
      (x.expireAt ? 2 : 0) + (x.value > 0 ? 1 : 0) + (x.channel?.length ? 1 : 0) +
      (x.valueKind === "coupon_price" ? 1 : 0);
    if (score(c) > score(prev)) byKey.set(key, c);
  }
  return [...byKey.values()].map((c) => decorateCoupon(c, { now }));
}

// --------------------------------------------------------------------------
// 活动日历
// --------------------------------------------------------------------------

/**
 * `campaign-calendar` → Campaign[]
 *
 * ⚠️ 活动内容里的价格（「9.9元」「13.9r」）是**营销文案**，无法与门店菜单核实，
 *    不可用于任何计算。本函数只取日期与标题，不解析文案里的数值。
 *
 * ⚠️ 实测返回 `{ data: { currentTime, dailyList: [...] } }`，业务 JSON 直挂顶层。
 */
export function collectCampaigns(raw) {
  const fromJson = collectCampaignsJson(raw);
  if (fromJson.length) return fromJson;
  return parseCampaignsMarkdown(raw).map((r) => ({
    date: r.date,
    phase: r.phase,
    titles: r.titles,
    highlights: r.highlights,
  }));
}

// --------------------------------------------------------------------------
// 积分抽奖
// --------------------------------------------------------------------------

/**
 * `query-lottery-info` → Lottery
 *
 * ⚠️ 不暴露奖品概率分布 —— 因此不做期望值点估计，只给价值区间 + 盈亏平衡概率。
 * ⚠️ 是否可参与以 `drawDecision.resourceEligible` 为准，**不从 availableTimes 推断**。
 */
export function collectLottery(data) {
  const d = data?.data || data || {};
  return {
    name: String(d.activityName || ""),
    status: String(d.activityStatusText || ""),
    drawPoint: num(d.drawPoint),
    drawType: String(d.drawTypeText || ""),
    availablePoint: num(d.availablePoint),
    availableTimes: d.availableTimes ?? null,
    beginAt: d.beginTime || null,
    endAt: d.endTime || null,
    resourceEligible: d.drawDecision?.resourceEligible ?? null,
    ineligibleReason: String(d.drawDecision?.reason || ""),
    prizes: (d.prizes || []).map((p) => ({
      name: String(p.name || ""),
      type: String(p.typeText || ""),
      imageUrl: String(p.imageUrl || ""),
    })),
  };
}

/** `query-my-prizes` → 奖品记录 */
export function collectPrizes(data) {
  const list = Array.isArray(data?.data?.prizes)
    ? data.data.prizes
    : Array.isArray(data?.prizes)
      ? data.prizes
      : [];
  return list.map((p) => ({
    name: String(p.name || ""),
    status: String(p.statusText || ""),
    recordedAt: String(p.recordTime || ""),
  }));
}

// --------------------------------------------------------------------------
// 门店与促销
// --------------------------------------------------------------------------

/**
 * `query-nearby-stores` → Store[]
 *
 * 该工具**必传 beType + searchType**（官方文档未写明，是实测契约）。
 *
 * ⚠️ 实测（2026-10-23）：返回 `{ data: [{ storeCode, storeName, address, distance, ... }] }`，
 *    业务 JSON 直挂顶层。
 *
 * ⚠️ `searchType=1`（收藏餐厅）在没有收藏记录时返回
 *    `{ success:false, code:600050, message:"收藏餐厅列表为空，请您提供城市+关键词进行搜索" }`
 *    —— **data 缺失，不是错误**。此时降级到 searchType=2（城市+关键词）。
 */
export function collectStores(raw) {
  const fromJson = collectStoresJson(raw);
  if (fromJson.length) return fromJson;

  // 回退：从 Markdown 文本抠（早期 fixture 形态）
  const s = String(raw || "");
  const out = [];
  const seen = new Set();
  const re = /([^|,\n()（）]{2,40}?)\s*[（(]\s*(\d{6,})\s*[)）]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const name = m[1].trim();
    const storeCode = m[2];
    if (!name || seen.has(storeCode)) continue;
    seen.add(storeCode);
    out.push({ storeCode, name, address: "", distance: null, beCode: "", businessStatus: null, businessStartTime: "", businessEndTime: "", reservation: false, reservationOptions: [] });
  }
  if (out.length) return out;
  const codes = s.match(/\b\d{7}\b/g) || [];
  return codes.map((c) => ({ storeCode: c, name: "", address: "", distance: null, beCode: "", businessStatus: null, businessStartTime: "", businessEndTime: "", reservation: false, reservationOptions: [] }));
}

/**
 * `query-promotions` → Promotion[]
 *
 * ⚠️ 这个工具**不在官方文档的 33 个工具里** —— 是 mcd-wrapped 的探测器
 *    实测发现的（参数 storeCode / orderType / beType，实测返回 12 条门店级促销）。
 *    它是「门店今日优惠套餐」的主力数据源。
 *
 * 促销内容里的价格同样属于营销文案，不可用于计算 —— 只取标题与描述。
 */
export function collectPromotions(data) {
  const d = data?.data || data || {};
  const list = Array.isArray(d) ? d : Array.isArray(d?.list) ? d.list : [];
  return list.map((p) => {
    if (typeof p === "string") return { title: p, description: "" };
    return {
      title: String(p?.title || p?.promotionName || p?.activityTitle || ""),
      description: String(p?.description || p?.content || p?.remark || ""),
    };
  });
}

/**
 * 解析 Markdown 形态的促销列表（`query-promotions` 返回 markdown-wrapper）。
 */
export function collectPromotionsMarkdown(rawText) {
  const s = String(rawText || "");
  const out = [];
  const re = /^#{1,4}\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(s)) !== null) {
    const title = m[1].trim();
    if (!title || /^Original Response$/i.test(title)) continue;
    out.push({ title, description: "" });
  }
  return out;
}

// --------------------------------------------------------------------------
// 快照组装
// --------------------------------------------------------------------------

/**
 * 把各采集结果组装成完整快照。
 *
 * @param {object} parts
 * @param {object} [parts.account]
 * @param {Array}  [parts.mall]
 * @param {Array}  [parts.coupons]
 * @param {Array}  [parts.campaigns]
 * @param {object} [parts.lottery]
 * @param {Array}  [parts.orders]
 * @param {Array}  [parts.stores]
 * @param {Array}  [parts.promotions]
 * @param {Array}  [parts.errors]  采集失败项
 */
export function assembleSnapshot(parts = {}) {
  return {
    generatedAt: new Date().toISOString(),
    source: "McDonald's China MCP Server (https://mcp.mcd.cn)",
    account: parts.account ?? null,
    mall: parts.mall ?? [],
    coupons: parts.coupons ?? [],
    campaigns: parts.campaigns ?? [],
    lottery: parts.lottery ?? null,
    orders: parts.orders ?? [],
    stores: parts.stores ?? [],
    promotions: parts.promotions ?? [],
    errors: parts.errors ?? [],
  };
}
