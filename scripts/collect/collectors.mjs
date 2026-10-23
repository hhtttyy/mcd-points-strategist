/**
 * mcd-points-strategist · 资产采集器
 *
 * 每个函数都是纯函数：(MCP 原始响应) => 契约对象。
 * 不发起网络请求 —— 网络由 app 层通过 MCP 工具发起，结果传进来。
 *
 * 这样拆分的目的：采集逻辑可离线测试（用 fixtures），且不与 IO 耦合。
 */

import {
  collectMallItems,
  collectOrders,
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
 * 实测返回的是 Markdown 文本，不是 JSON。
 */
export function collectAvailableCoupons(rawText, { now = new Date() } = {}) {
  const rows = parseCouponListMarkdown(rawText);
  return rows.map((r, i) =>
    decorateCoupon(
      {
        id: `mcd-savers-${i}-${r.name}`,
        name: r.name,
        value: 0,
        threshold: 0,
        expireAt: null,
        expireText: "",
        dayWindow: "",
        weekdays: [],
        weekdayText: "",
        channel: [],
        validFrom: null,
        source: "mcd-savers",
        status: r.status,
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
 */
export function collectMyCoupons(rawText, { now = new Date() } = {}) {
  const rows = parseMyCouponsMarkdown(rawText);
  return rows.map((r, i) =>
    decorateCoupon(
      {
        id: `my-${i}-${r.name}`,
        name: r.name,
        value: r.value,
        threshold: 0,
        expireAt: r.expireAt,
        expireText: r.expireText,
        dayWindow: r.dayWindow,
        weekdays: r.weekdays,
        weekdayText: r.weekdayText,
        channel: r.channel,
        validFrom: toIso(parseValidFrom(r.expireText)),
        source: "my",
        status: "已领取",
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
 */
export function collectStoreCoupons(rawText, { now = new Date() } = {}) {
  const rows = parseMyCouponsMarkdown(rawText);
  return rows.map((r, i) =>
    decorateCoupon(
      {
        id: `store-${i}-${r.name}`,
        name: r.name,
        value: r.value,
        threshold: 0,
        expireAt: r.expireAt,
        expireText: r.expireText,
        dayWindow: r.dayWindow,
        weekdays: r.weekdays,
        weekdayText: r.weekdayText,
        channel: r.channel,
        validFrom: toIso(parseValidFrom(r.expireText)),
        source: "store",
        status: "门店可用",
        itemCodes: [],
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
 * 去重键用「券名 + 有效期起止」—— 同一张券在 my 与 store 中都出现时，
 * 保留**信息更全**的那份（store 通常带更精确的门店场景）。
 */
export function mergeCoupons(sources, { now = new Date() } = {}) {
  const all = sources.flat().filter(Boolean);
  const byKey = new Map();
  for (const c of all) {
    const key = `${c.name}|${c.expireText || ""}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
      continue;
    }
    // 已存在同名同期的券：保留信息更全的（字段更非空）
    const score = (x) =>
      (x.expireText ? 2 : 0) + (x.value > 0 ? 1 : 0) + (x.channel.length ? 1 : 0);
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
 */
export function collectCampaigns(rawText) {
  const rows = parseCampaignsMarkdown(rawText);
  return rows.map((r) => ({
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
 * 返回的是 text 形态，需从文本里抠出 storeCode 与名称。
 */
export function collectStores(rawText) {
  const s = String(rawText || "");
  const out = [];
  const seen = new Set();
  // 典型形态：店名(门店编码) 或 店名 | 编码
  const re = /([^|,\n()（）]{2,40}?)\s*[（(]\s*(\d{6,})\s*[)）]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const name = m[1].trim();
    const storeCode = m[2];
    if (!name || seen.has(storeCode)) continue;
    seen.add(storeCode);
    out.push({ storeCode, name, address: "", distance: null });
  }
  if (out.length) return out;
  // 回退：只抠编码
  const codes = s.match(/\b\d{7}\b/g) || [];
  return codes.map((c) => ({ storeCode: c, name: "", address: "", distance: null }));
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
