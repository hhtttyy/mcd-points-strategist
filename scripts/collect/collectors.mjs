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

/** 四舍五入到指定小数位。 */
function round(v, p = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

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
        // ⚠️ id 必须包含**到期时刻**，否则同名的不同批次券会被合并成一张。
        //    （真实结构里 id 来自 couponId，天然唯一；这里是无 id 时的回退路径。）
        id: r.id || `my-${r.name}-${r.expireAt || i}`,
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
    // ⚠️ 合并键：**优先用 couponId**，它是券的唯一标识。
    //
    // 实测（2026-10-23 领券后，六道口店）：
    //   卡包 `my`     用 `id`，        门店 `store` 用 `couponId`，**值一致**
    //   同一张券两路的到期日可能不同：
    //     卡包 tradeStartDateTime/tradeEndDateTime = "2026-10-19 10:30:00-2026-10-23 23:59:59"
    //     门店 tradeDateTime（区间）               = "2026-10-19 10:30:00-2026-10-23 23:59:59"
    //   用「券名+到期日」做键 → 同一张券被算成两张。
    //   用 couponId 做键 → 正确合并。
    //
    // ⚠️ 但**同名不等于同一张券**：
    //   领券后卡包有 5 张，其中「11.9元麦辣鸡腿堡」有两张
    //   （couponId A2552803… 到期 10-23 / couponId B34E5EC6… 到期 10-30）
    //   —— 它们是**不同批次**的券，各有各的 couponId，必须分开。
    //   所以键用 couponId 正好同时满足「同券合并」与「异券分开」。
    //
    // 无 couponId 时（可领券接口不返回）回退到「券名+到期日」。
    const key = c.id || c.code
      ? `id:${c.id || c.code}`
      : `name:${c.name}|${c.expireAt || "no-expire"}`;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...c });
      continue;
    }

    // ⚠️ 必须**逐字段取并集**，不能二选一。
    //    实测（2026-10-23）同一张券在三路的字段分布：
    //      卡包（my）  ：value=20.48、valueKind=coupon_price、dayWindow、weekdays、channel
    //      门店（store）：itemCodes=['9900016523']、itemNames、couponCode
    //      麦麦省      ：无
    //    二选一的话：
    //      选门店那份 → 丢掉「用券价格」语义与时段限制（无法判断何时能用）
    //      选卡包那份 → 丢掉适用商品编码（无法定位到菜品、无法测算实际优惠额）
    //    两个都不可接受。逐字段取并集才能同时拿到「何时能用」与「能省多少」。
    const merged = { ...prev };
    for (const [k, v] of Object.entries(c)) {
      const pv = merged[k];
      const empty =
        v === undefined ||
        v === null ||
        v === "" ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === "number" && !Number.isFinite(v));
      const pEmpty =
        pv === undefined ||
        pv === null ||
        pv === "" ||
        (Array.isArray(pv) && pv.length === 0) ||
        (typeof pv === "number" && !Number.isFinite(pv));
      if (empty) continue;
      if (pEmpty) {
        merged[k] = v;
        continue;
      }
      // 数组：取并集（保留原有顺序）
      if (Array.isArray(v) && Array.isArray(pv)) {
        const union = [...pv];
        for (const x of v) if (!union.includes(x)) union.push(x);
        merged[k] = union;
        continue;
      }
      // 标量冲突：保留**信息量更大**的那个
      // 关键：valueKind 若一方是 coupon_price 而另一方是 discount_amount，
      // 保留 coupon_price —— 因为它更严格（宁可说「不知道省多少」也不误报优惠额）。
      if (k === "valueKind") {
        if (v === "coupon_price" || pv !== "coupon_price") merged[k] = v;
        continue;
      }
      // ⚠️ 0 不应覆盖非 0 —— 实测：门店券接口不返回面值（value=0），
      //    卡包券有真实面值（20.48）。若让门店的 0 覆盖卡包的值，
      //    合并后券的面值就丢了。
      if (typeof pv === "number" && typeof v === "number") {
        if (pv === 0 && v !== 0) merged[k] = v;
        continue;
      }
      // 券码/ID：不同源用不同字段名，优先保留有值的
      if (k === "id" || k === "code") {
        if (!pv) merged[k] = v;
        continue;
      }
      // 其余：门店源优先（它更贴近「当前门店可用」的真实场景）
      if (c.source === "store" && prev.source !== "store") merged[k] = v;
    }
    // 保留来源集合 —— 用于判断「这张券在哪些视角下可见」
    merged.sources = [...new Set([...(prev.sources || [prev.source]), ...(c.sources || [c.source])])];
    byKey.set(key, merged);
  }

  // ⚠️ 第二轮：把「可领券」与「卡包券」按**券名**关联。
  //
  // 实测（2026-10-23 领券后）：`available-coupons` 的 `couponStatus`
  // 从 CAN_GET 变成 HAVING_RECEIVE（已领取）—— 接口**是有状态的**，
  // 领过的券仍会出现在列表里，只是状态变了。
  //
  // 但如果两路状态不一致（接口有延迟，或某路缓存），就会出现
  // 「卡包里明明有这张券，麦麦省还说可领取」→ 看板会把已领的券
  // 列进「可领未领」，用户去领却领不到。
  //
  // 判定：**卡包里已存在同名券 → 麦麦省那条不再算「可领取」**。
  // ⚠️ 注意同名可能是不同批次 —— 但「是否可领」这件事上，
  //    只要卡包里有同名券，就说明这一批至少已经有一张在手，
  //    再提示「可领取」是没有意义的（领了也会重复）。
  const inWallet = new Set(
    all.filter((c) => c.source === "my" || (c.sources || []).includes("my")).map((c) => c.name)
  );
  const mergedList = [...byKey.values()];

  // 先把已持有的券按名字索引（用于吸收麦麦省的无券信息行）
  const walletByName = new Map();
  for (const c of mergedList) {
    if (c.source === "my" || (c.sources || []).includes("my")) {
      if (!walletByName.has(c.name)) walletByName.set(c.name, []);
      walletByName.get(c.name).push(c);
    }
  }

  const out = [];
  for (const c of mergedList) {
    if (c.source === "mcd-savers") {
      if (c.status === "可领取" && inWallet.has(c.name)) {
        c.status = "已领取";
        c.claimedInWallet = true;
      }
      // ⚠️ 麦麦省这条**没有券码/到期日/面值**（接口只给名称+图片+状态）。
      //    卡包里已有同名券时，它就是那张券的「无信息视角」——
      //    保留会造成看板出现两条同名的空条目（面值 ¥0、到期 —）。
      //    直接丢弃，用卡包那条（含完整信息）代表它。
      const wallet = walletByName.get(c.name);
      if (wallet && wallet.length) continue;
    }
    out.push(c);
  }

  return out.map((c) => decorateCoupon(c, { now }));
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
 *    实测发现的（参数 storeCode / orderType / beType）。
 *    它是「门店今日优惠套餐」的主力数据源。
 *
 * ⚠️ 实测（2026-10-23 六道口店 1950979）：真实返回的是**结构化促销规则**，
 *    不是文案：
 * ```json
 * {
 *   "promotionId": "331878001",
 *   "promotionType": "33",
 *   "ruleCategory": 30,
 *   "beTypes": ["6"],                  ← 适用渠道
 *   "startTime": "2025-03-01 00:00:00",
 *   "endTime": "2026-12-31 23:59:59",
 *   "products": [{ "type": "2", "productCode": "9900016058" }, ...],
 *   "ruleDetail": {
 *     "orderDiscount": { "discount": "26", "startDiscountPoint": "500" }
 *   }
 * }
 * ```
 *   语义：**订单满 `startDiscountPoint` 元减 `discount` 元**。
 *
 * ⚠️⚠️ 最重要的坑：**该工具忽略传入的 beType。**
 *    实测传 beType=1（到店自取）/ 2（外送）/ 6（团餐），
 *    beType=1 返回 12 条且全部 `beTypes:["6"]`（团餐），
 *    beType=2 与 6 都返回 0 条。
 *    → 也就是说，**用 beType=1 查到的 12 条其实是团餐促销，对到店自取不生效**。
 *
 *    因此必须按 `beTypes` 过滤，并在不匹配时明确告知「这些是团餐规则，
 *    你到店自取用不上」，而不是把它们当成「今天这家店的优惠」报出去。
 */
export function collectPromotions(data, { beType = null, now = new Date() } = {}) {
  const d = data?.data || data || {};
  const list = Array.isArray(d) ? d : Array.isArray(d?.list) ? d.list : [];

  const out = list.map((p) => {
    // 规则解析：orderDiscount = 订单满额减
    const od = p?.ruleDetail?.orderDiscount;
    const threshold = num(od?.startDiscountPoint);
    const discount = num(od?.discount);
    const rate = threshold > 0 ? round(discount / threshold, 4) : null;

    // beTypes 映射：1 到店自取 / 2 麦乐送 / 5 得来速 / 6 团餐
    const beTypeList = (p?.beTypes || []).map((x) => num(x)).filter((n) => n > 0);
    const beTypeNames = { 1: "到店自取", 2: "麦乐送", 5: "得来速", 6: "团餐" };
    const channelText = beTypeList.map((t) => beTypeNames[t] || `beType${t}`).join("、");

    // 生效判定
    const startAt = p?.startTime || null;
    const endAt = p?.endTime || null;
    const startD = startAt ? new Date(String(startAt).replace(" ", "T")) : null;
    const endD = endAt ? new Date(String(endAt).replace(" ", "T")) : null;
    const isLive = (!startD || startD <= now) && (!endD || endD >= now);

    return {
      promotionId: String(p?.promotionId || ""),
      type: String(p?.promotionType || ""),
      // 规则本体
      rule: od ? "order_discount" : "unknown",
      threshold,
      discount,
      rate,
      // 适用商品编码
      itemCodes: (p?.products || []).map((x) => String(x.productCode || "")).filter(Boolean),
      // 渠道
      beTypes: beTypeList,
      channelText,
      // ⚠️ 渠道是否适用**不在这里判定** —— 它依赖当下的就餐方式
      //    （到店自取 / 麦乐送 / 团餐），是运行时变量。
      //    实测：同一个店按 beType=1 查到的规则可能全是团餐的，
      //    按 beType=6 分析时又该生效 —— 若在采集阶段固化，
      //    后续换渠道分析就无法恢复。判定统一放在 analyze/promotion-rules.mjs。
      appliesToChannel: null,
      // 生效期
      startAt,
      endAt,
      isLive,
      // 展示用
      title: od
        ? `满 ${threshold} 减 ${discount}`
        : `促销 ${p?.promotionId || ""}`,
      description: [
        od ? `订单满 ¥${threshold} 减 ¥${discount}` : null,
        rate ? `相当于 ${(rate * 100).toFixed(1)}% off` : null,
        channelText ? `适用：${channelText}` : null,
        endAt ? `截止 ${String(endAt).slice(0, 10)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });

  return out;
}

/** 保留旧签名（传字符串时按 Markdown 解析）—— 仅供 fixture 回归使用。 */
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
 * @param {string} [parts.storeCode] 本次核对的门店
 * @param {Array}  [parts.menu]      门店实时菜单
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
    // 本次核对的门店 —— 渲染「门店优惠」区块时用来显示门店名
    storeCode: parts.storeCode ?? null,
    // 门店实时菜单 —— 用来算券的实际优惠额与凑单建议
    menu: parts.menu ?? [],
    errors: parts.errors ?? [],
  };
}
