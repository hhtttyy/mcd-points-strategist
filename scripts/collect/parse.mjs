/**
 * mcd-points-strategist · 采集层公共工具
 *
 * 本层是**唯一允许把 MCP 原始响应转成契约对象**的地方。
 * 所有函数都是纯函数：(原始响应, 选项) => 契约对象
 * 不发起网络请求、不读环境变量、不打印。
 *
 * 核心纪律：MCP 金额单位是「分」，转换只允许发生在这里。
 */

import { classifyCoupon } from "../lib/schema.mjs";

export const CENTS_PER_YUAN = 100;

/** 分 → 元。忘记换算是本项目最容易踩的坑，所有转换必须走这个函数。 */
export function centsToYuan(cents) {
  if (cents === null || cents === undefined || cents === "") return 0;
  const n = Number(cents);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / CENTS_PER_YUAN * 100) / 100;
}

export function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 宽松日期解析：兼容 "2026-10-15 05:00:00" / ISO / "2026年10月15日"。 */
export function parseTime(s) {
  if (!s) return null;
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  let text = String(s).trim();
  const cn = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (cn) {
    const d = new Date(Number(cn[1]), Number(cn[2]) - 1, Number(cn[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  text = text.replace(" ", "T");
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toIso(d) {
  if (!d) return null;
  return d.toISOString();
}

/** 今天（本地时区）的 YYYY-MM-DD。 */
export function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 解析标的面值（元）。
 *
 * 关键实测：MCP 的 `mall-points-products` 中，积分类标的（point > 0）
 * 其 `price` 字段**恒为 0**，真实面值藏在 `spuName` 前缀里。
 *   「18.8元2份麦辣鸡翅」→ 18.8
 *   「6.9元可乐麦炫酷」    → 6.9
 *   「罗技键鼠套装」       → 无法解析（实物类，不参与密度排名）
 * 若误用 `price` 字段，全部积分类标的密度均为 0，排序结果完全失真。
 */
export function parseFaceValue(name, priceField) {
  const fromName = /^([\d.]+)\s*元/.exec(String(name || ""));
  if (fromName) return { value: num(fromName[1]), source: "spuName" };
  const p = num(priceField);
  if (p > 0) return { value: p, source: "priceField" };
  return { value: 0, source: "unknown" };
}

/**
 * 判定商城标的的上下架状态。
 *
 * 必须看 `downTime` 而非 `status` —— 实测 24 个积分类商品里 15 个
 * 兑换截止日已过但接口状态仍报「上架」。只看 status 会让用户
 * 为了一个早已结束的活动去攒积分，这是纯浪费。
 */
export function resolveMallStatus(upTime, downTime, now = new Date()) {
  const up = parseTime(upTime);
  const down = parseTime(downTime);
  if (down && down < now) return "expired";
  if (up && up > now) return "upcoming";
  return "live";
}

/**
 * 解析星期限制。
 *
 * 实测券的有效期原文形如：
 *   「2026-10-12 10:30-2026-10-16 23:59 周一、二、三、四、五 10:30-23:59」
 *   「2026-10-15 05:00-2026-10-15 10:29 周四 05:00-10:29」
 *
 * ⚠️ 编码统一为 **0=周日**（与 JS `getDay()` 一致）：
 *   周日=0、周一=1、周二=2、周三=3、周四=4、周五=5、周六=6。空数组 = 不限。
 *
 *   这个编码必须与原生 `weekdays` 数组（1=周日，转换后减 1）以及
 *   analyze 层的 `getDay()` 判定完全一致 —— 三处曾经各用一套，
 *   导致券的可用天数算错、星期判定错位一天。
 */
const WEEKDAY_MAP = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

export function parseWeekdays(text) {
  const s = String(text || "");
  if (!/周|星期|礼拜/.test(s)) return [];
  // 只在「周X」之后紧邻的连续星期序列里匹配，避免误吃日期中的数字
  const m = s.match(/周([一二三四五六日天](?:[、,，]\s*[一二三四五六日天])*)/);
  if (!m) return [];
  const chars = m[1].split(/[、,，]/).map((c) => c.trim()).filter(Boolean);
  const out = new Set();
  for (const c of chars) {
    if (WEEKDAY_MAP[c] !== undefined) out.add(WEEKDAY_MAP[c]);
  }
  return [...out].sort();
}

/**
 * 解析单日券的可用时段，如 "05:00-10:29"。
 *
 * 注意：多日券的原文里也会出现时段（如「周一至周五 10:30-23:59」），
 * 但那是「每天的时段」，不是「单日券」。两者语义不同，靠调用方区分。
 */
export function parseDayWindow(text) {
  const s = String(text || "");
  const m = s.match(/(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})/g);
  if (!m || !m.length) return "";
  return m[m.length - 1];
}

/**
 * 解析渠道标签。
 *
 * 实测券的「标签」字段形如「到店专用、外送专用」：
 *   含「到店」→ pickup
 *   含「外送」或「麦乐送」→ delivery
 */
export function parseChannel(text) {
  const s = String(text || "");
  const out = [];
  if (/到店|自取|堂食/.test(s)) out.push("pickup");
  if (/外送|麦乐送|配送/.test(s)) out.push("delivery");
  return out;
}

/**
 * 解析券的有效期截止时刻。
 *
 * 取原文里最晚的时间点作为截止时刻。找不到时返回 null（= 未知期限，
 * 渲染时**不得**说成「无期限」）。
 */
export function parseExpireAt(text) {
  const s = String(text || "");
  const times = s.match(/\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/g);
  if (!times || !times.length) return null;
  let latest = null;
  for (const t of times) {
    const d = parseTime(t);
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}

/**
 * 解析生效日。
 *
 * 早餐券可能「明天才开始生效」—— 实测存在有效期在未来日期的券。
 * 把它当成今天可用会给出错误建议。
 */
export function parseValidFrom(text) {
  const s = String(text || "");
  const times = s.match(/\d{4}-\d{2}-\d{2}/g);
  if (!times || !times.length) return null;
  let earliest = null;
  for (const t of times) {
    const d = parseTime(t);
    if (d && (!earliest || d < earliest)) earliest = d;
  }
  return earliest;
}

/** 券的 5 类判定 + 保守的叠加默认值。 */
export function decorateCoupon(coupon, { now = new Date() } = {}) {
  const type = classifyCoupon(coupon);
  // 拿不准 stackable 时一律 false —— 宁可少报优惠，也不给「付不出来的假便宜」
  const stackable = coupon.stackable === true;
  const expireAt = coupon.expireAt ? parseTime(coupon.expireAt) : null;

  let daysLeft = null;
  if (expireAt) {
    daysLeft = Math.ceil((expireAt.getTime() - now.getTime()) / 86400000);
  }

  const validFrom = coupon.validFrom ? parseTime(coupon.validFrom) : null;
  const isUsableNow = !validFrom || validFrom <= now;

  // ⚠️ benefit（这张券能省多少钱）与 value（接口给的数字）**不是一回事**。
  //    实测（2026-10-23 真实调用）：卡包券的 discountInfo.discountDesc
  //    明确写着 "用券价格" —— 那是**你用券后要付的钱**，不是省下的钱。
  //    例如「1024码力翻倍 ¥20.48」= 两件套到手价 ¥20.48，
  //    绝不能说成「这张券省了 20.48 元」。
  //
  //    只有 discountDesc 表达「减免金额」时，value 才等于 benefit。
  //    coupon_price 语义下，节省额要拿菜单原价对比才能算 ——
  //    没有原价时**报未知，绝不编造**。
  const valueKind = coupon.valueKind || "discount_amount";
  const benefitKnown = valueKind !== "coupon_price" && Number(coupon.value) > 0;

  return {
    ...coupon,
    type,
    stackable,
    daysLeft,
    usableSlots: coupon.usableSlots ?? null,
    isUsableNow,
    valueKind,
    // benefit = 可确证的优惠金额；benefitKnown=false 时为 null（不是 0）
    benefit: benefitKnown ? Number(coupon.value) : null,
    benefitKnown,
  };
}

/**
 * 从 Markdown 文本里提取优惠券列表（`available-coupons` 返回格式）。
 *
 * 实测格式：
 *   ### 麦麦省优惠券列表：
 *   - 优惠券标题：中薯条买一送一 \
 *     状态：已领取 \
 *   - 优惠券标题：免费脆薯饼 \
 *     状态：可领取 \
 */
export function parseCouponListMarkdown(text) {
  const s = String(text || "");
  const out = [];
  const re = /优惠券标题[：:]\s*(.+?)\s*\\\s*\n\s*状态[：:]\s*(.+?)\s*\\?\s*$/gm;
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push({ name: m[1].trim(), status: m[2].trim() });
  }
  return out;
}

/**
 * 从 Markdown 文本里提取「我的优惠券」列表（`query-my-coupons` 返回格式）。
 *
 * 实测格式：
 *   ## 中薯条买一送一
 *   - **优惠**: ¥13.5 (用券价格)
 *   - **有效期**: 2026-10-12 10:30-2026-10-16 23:59 周一、二、三、四、五 10:30-23:59
 *   - **领取时间**: 4日前收到
 *   - **标签**: 到店专用、外送专用
 */
export function parseMyCouponsMarkdown(text) {
  const s = String(text || "");
  const out = [];
  // 以「## 券名」开头的新券
  const blocks = s.split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const name = (lines[0] || "").trim();
    if (!name) continue;
    if (/优惠券列表|共\s*\d+\s*张|第\s*\d+\/\d+\s*页|每页/.test(name)) continue;

    const valueMatch = block.match(/\*\*优惠\*\*[：:]\s*¥?\s*([\d.]+)/);
    const expireMatch = block.match(/\*\*有效期\*\*[：:]\s*(.+)/);
    const labelMatch = block.match(/\*\*标签\*\*[：:]\s*(.+)/);
    const receiveMatch = block.match(/\*\*领取时间\*\*[：:]\s*(.+)/);

    const expireText = expireMatch ? expireMatch[1].trim() : "";
    const labelText = labelMatch ? labelMatch[1].trim() : "";

    out.push({
      name,
      value: valueMatch ? num(valueMatch[1]) : 0,
      expireText,
      expireAt: toIso(parseExpireAt(expireText)),
      dayWindow: parseDayWindow(expireText),
      weekdays: parseWeekdays(expireText),
      weekdayText: (expireText.match(/周[一二三四五六日天、,，\s]*/) || [""])[0].trim(),
      channel: parseChannel(labelText),
      labelText,
      receivedText: receiveMatch ? receiveMatch[1].trim() : "",
    });
  }
  return out;
}

/**
 * 从 Markdown 文本里提取活动日历（`campaign-calendar` 返回格式）。
 *
 * 实测格式：
 *   #### 2026年10月14日 今日
 *   -   **活动标题**：超值𝟗.𝟗元早餐两件套陪你开工啦😋
 *   -   **活动标题**：乐享90分钟高质量亲子时间
 *
 * ⚠️ 活动内容里的价格（「9.9元」「13.9r」）是**营销文案**，无法核实，
 * 不可用于任何计算。本函数只取日期与标题，不取文案里的数值。
 */
export function parseCampaignsMarkdown(text) {
  const s = String(text || "");
  const out = [];
  const blocks = s.split(/^####\s+/m).slice(1);
  for (const block of blocks) {
    const head = (block.split(/\r?\n/)[0] || "").trim();
    const dm = head.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!dm) continue;
    const date = `${dm[1]}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}`;
    const phase = head.replace(dm[0], "").trim();

    const titles = [];
    for (const m of block.matchAll(/\*\*活动标题\*\*[：:]\s*(.+)/g)) {
      titles.push(m[1].trim());
    }
    const hm = block.match(/\*\*活动内容介绍\*\*[：:]\s*([\s\S]*?)(?=\n\s*\*\*活动图片介绍\*\*|\n-|\n####|$)/);
    out.push({
      date,
      phase,
      titles,
      highlights: hm ? hm[1].trim().slice(0, 300) : "",
    });
  }
  return out;
}

/**
 * 从「我的优惠券」的真实 JSON 结构转成契约对象。
 *
 * ⚠️ 实测（2026-10-23 真实调用）：`query-my-coupons` 返回的是
 *   `{ success, code, data: { coupons: [...] } }` —— **业务 JSON 直挂顶层**，
 *   不是标准 MCP 的 `{ content: [...] }` 信封。
 *
 *   好处：时段、星期、渠道、有效期都是**原生结构化字段**，
 *   完全不需要从 Markdown 文本里正则抠：
 *   - tradeStartDateTime / tradeEndDateTime  精确到秒的起止
 *   - tradeTimePeriods[{startTime,endTime}]  每日可用时段
 *   - weekdays[] + isAllTradeTime           星期限制（空数组 = 不限）
 *   - instructions.labels[].text             渠道标签（"到店" / "外送"）
 *   - discountInfo.discountValue            用券价格
 *   - discountInfo.discountDesc             面值语义（"用券价格" / "优惠金额"）
 *
 *   对比：从 Markdown 抠「有效期」那行再解析，星期与时段混在同一串文本里，
 *   单日券与多日券的语义完全不同，极易判错。原生字段没有这个问题。
 */
export function collectMyCouponsJson(data) {
  const list = Array.isArray(data?.data?.coupons)
    ? data.data.coupons
    : Array.isArray(data?.coupons)
      ? data.coupons
      : Array.isArray(data?.data)
        ? data.data
        : [];

  return list.map((c) => {
    // 时段：原生数组，取第一个（目前实测均只有一个时段）
    const periods = Array.isArray(c.tradeTimePeriods) ? c.tradeTimePeriods : [];
    const dayWindow = periods.length
      ? `${String(periods[0].startTime || "").slice(0, 5)}-${String(periods[0].endTime || "").slice(0, 5)}`
      : "";

    // ⚠️⚠️ 星期数组的编码是 **1=周日**（即 JS `getDay()` + 1），
    //    不是 JS `getDay()` 的 0=周日 —— **整体差一位**。
    //
    //    实测证据（2026-10-23 六道口店）：
    //      券的 tradeStartDateTime = 2026-10-19（周一）
    //      tradeEndDateTime   = 2026-10-23（周五）
    //      同一张券的 instructions.availableTime 文案写着「周一、二、三、四、五」
    //      而 weekdays 数组是 [2,3,4,5,6]
    //      → 2=周一、3=周二、4=周三、5=周四、6=周五 ✓ 与文案完全一致
    //      → 若按 0=周日 解读会得到「周二~周六」，与文案矛盾
    //
    //    错位的实际后果（实测）：
    //      周六 真实不可用 → 我的旧代码判为可用
    //      周一 真实可用   → 我的旧代码判为不可用
    //    也就是说**每个周末和每个周一都会判错**。
    //
    //    统一在这里转成内部约定的 **0=周日**（与 JS getDay() 一致），
    //    下游全部按 0=周日 处理。
    const isAll = c.isAllTradeTime === 1 || c.isAllTradeTime === "1";
    const weekdays = isAll
      ? []
      : (Array.isArray(c.weekdays) ? c.weekdays : [])
          .map((w) => Number(w))
          .filter((n) => n >= 1 && n <= 7)
          .map((n) => n - 1); // 1=周日 → 0=周日

    // 渠道：原生标签。实测 "到店" / "外送" / "到店、外送"
    const labels = (c.instructions?.labels || []).map((l) => String(l.text || ""));
    const labelText = labels.join("、");
    const channel = parseChannel(labelText);

    // ⚠️ 服务端的 `instructions.availableTime` 里带**权威文案**：
    //   [{ text: "2026.10.19-2026.10.23", type: 1 },
    //    { text: "周一、二、三、四、五", type: 2 },   ← 星期说明
    //    { text: "10:30-23:59", type: 1 }]
    //   直接用它作为 weekdayText，比自己从数组反推更可靠
    //   （数组编码有坑，文案不会错）。
    const availText = (c.instructions?.availableTime || []).map((t) => String(t.text || ""));
    const serverWeekdayText = availText.find((t) => /周[一二三四五六日]/.test(t)) || "";
    const serverWindowText = availText.find((t) => /\d{1,2}:\d{2}\s*[-–~]\s*\d{1,2}:\d{2}/.test(t)) || "";
    // 渠道也可能只在 availableTime 里（如「到店专用」）
    const channelFromAvail = availText.find((t) => /到店|外送|麦乐送|专享/.test(t)) || "";

    const startAt = c.tradeStartDateTime || null;
    const endAt = c.tradeEndDateTime || null;

    return {
      id: String(c.id || c.couponId || ""),
      code: String(c.code || c.couponCode || ""),
      name: String(c.title || ""),
      subtitle: String(c.subtitle || ""),
      value: num(c.discountInfo?.discountValue),
      valueDesc: String(c.discountInfo?.discountDesc || ""),
      // discountDesc 决定这个数字是「用券价格」还是「减免金额」——
      // 两者语义不同，不可混用（详见 references/mcp-pitfalls.md）
      valueKind: c.discountInfo?.discountDesc === "用券价格" ? "coupon_price" : "discount_amount",
      expireAt: toIso(parseTime(endAt)),
      validFrom: toIso(parseTime(startAt)),
      expireText: endAt || "",
      dayWindow,
      dayWindows: periods.map((p) => `${String(p.startTime || "").slice(0, 5)}-${String(p.endTime || "").slice(0, 5)}`),
      weekdays,
      // ⚠️ 优先用服务端文案（「周一、二、三、四、五」），它比数组反推可靠
      // ⚠️ 索引顺序必须与编码一致：0=周日 → "日一二三四五六"
      weekdayText: serverWeekdayText || (weekdays.length ? weekdays.map((w) => "周" + "日一二三四五六"[w]).join("、") : "不限"),
      channel: channel.length ? channel : parseChannel(channelFromAvail),
      labelText,
      // 服务端给的状态标签（如「未到使用时间」「到店」）
      serverLabel: labels.join("、"),
      availableTexts: availText,
      receivedText: "",
      source: "my",
      status: "已领取",
      totalCount: num(c.totalCount, 1),
    };
  });
}

/**
 * 从「麦麦省可领券」的真实 JSON 结构转成契约对象。
 *
 * ⚠️ 实测：`available-coupons` 返回 `{ data: [ {couponName, couponImage, couponStatus, label} ] }`，
 *   直挂顶层，无 content 信封。
 *
 * ⚠️ 重要口径：`couponStatus` 为 CAN_GET 表示**可领取**。
 *   该接口**不接受任何参数**，返回账户全域的券 —— 与门店无关。
 *   所以「先领券再核实门店」是对的流程：领券零成本、零门店依赖。
 */
export function collectAvailableCouponsJson(data) {
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data)
      ? data
      : [];
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const name = String(c.couponName || c.name || "").trim();
    if (!name) continue;
    // 实测会返回同名券的多份（不同图片 = 不同批次），按名称去重
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      id: String(c.id || c.couponId || ""),
      name,
      value: 0, // 可领券接口不返回面值 —— 领了之后从 query-my-coupons 才能拿到
      status: c.couponStatus === "CAN_GET" ? "可领取" : String(c.label || c.couponStatus || ""),
      imageUrl: String(c.couponImage || ""),
      source: "mcd-savers",
      channel: [],
      weekdays: [],
      dayWindow: "",
      expireAt: null,
      validFrom: null,
      labelText: String(c.label || ""),
    });
  }
  return out;
}

/**
 * 从活动日历的真实 JSON 结构转成契约对象。
 *
 * ⚠️ 实测：`campaign-calendar` 返回
 *   `{ data: { currentTime, dailyList: [{ date, dateText, events: [...] }] } }`，直挂顶层。
 *
 * ⚠️ 活动内容里的价格（「9.9元」「13.9r」）是**营销文案**，无法核实，
 *   不可用于任何计算。本函数只取日期与标题，不取文案里的数值。
 */
export function collectCampaignsJson(data) {
  const daily = Array.isArray(data?.data?.dailyList)
    ? data.data.dailyList
    : Array.isArray(data?.dailyList)
      ? data.dailyList
      : [];
  return daily.map((d) => {
    const events = Array.isArray(d.events) ? d.events : [];
    const titles = [];
    const highlights = [];
    for (const e of events) {
      // ⚠️ 实测：标题与正文都在 `articleDto` 里，顶层的 `activityTitle` 是**空串**。
      //    直接读 activityTitle 会让所有活动标题变成空数组。
      //    （这与 maimai-butler 参考项目的 articleDto 解析口径一致）
      const ad = e?.articleDto && typeof e.articleDto === "object" ? e.articleDto : null;
      const t = String(ad?.title || e?.activityTitle || e?.title || "").trim();
      if (t && !titles.includes(t)) titles.push(t);
      const c = String(ad?.content || ad?.highlights || e?.activityContent || e?.content || "").trim();
      if (c && !highlights.includes(c)) highlights.push(c);
    }
    // phase 从 dateText 里剥出来（「2026年10月22日 往期回顾」→「往期回顾」）
    const dateText = String(d.dateText || "");
    const phase = dateText.replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*/, "").trim();
    return {
      date: String(d.date || ""),
      phase,
      titles,
      highlights: highlights.join("\n").slice(0, 300),
    };
  });
}

/**
 * 从「门店可用券」的真实 JSON 结构转成契约对象。
 *
 * ⚠️ 实测：`query-store-coupons` 返回
 *   `{ data: [{ title, couponId, couponCode, tradeDateTime, products:[{productCode,productName}] }] }`
 *   业务 JSON 直挂顶层。
 *
 * ⚠️ 口径说明：门店券的 `tradeDateTime` 是**日期区间**（无时分秒），
 *    不像卡包券那样带每日时段。所以门店券的 dayWindow 为空 ——
 *    它没有「每天 10:30 后才能用」这种限制。
 */
export function collectStoreCouponsJson(data) {
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data)
      ? data
      : [];
  return list.map((c) => {
    const td = String(c.tradeDateTime || "");
    // "2026-10-23 00:00:00-2026-10-29 23:59:59" → 拆成起止
    const m = td.match(
      /(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?)/
    );
    const startAt = m ? m[1] : td.split("-")[0]?.trim() || null;
    const endAt = m ? m[2] : null;
    return {
      id: String(c.couponId || c.id || ""),
      code: String(c.couponCode || c.code || ""),
      name: String(c.title || ""),
      value: 0, // 门店券接口不返回面值
      valueDesc: "",
      valueKind: "discount_amount",
      expireAt: toIso(parseTime(endAt)),
      validFrom: toIso(parseTime(startAt)),
      expireText: td,
      dayWindow: "",
      dayWindows: [],
      weekdays: [],
      weekdayText: "不限",
      channel: [],
      labelText: "",
      itemCodes: (c.products || []).map((p) => String(p.productCode || "")),
      itemNames: (c.products || []).map((p) => String(p.productName || "")),
    };
  });
}

/**
 * 从「附近门店」的真实 JSON 结构转成契约对象。
 *
 * ⚠️ 实测：`query-nearby-stores` 返回
 *   `{ data: [{ storeCode, storeName, address, distance, beCode, businessStatus,
 *              businessStartTime, businessEndTime, reservation, reservationTimeOptions }] }`
 *
 * ⚠️ 重要：`searchType=1`（收藏餐厅）在没有收藏记录时返回
 *   `{ success:false, code:600050, message:"收藏餐厅列表为空…" }` —— **data 缺失**。
 *   此时必须降级为 `searchType=2`（按城市+关键词搜索），
 *   否则门店列表永远为空。这不是错误，是正常的空态。
 */
export function collectStoresJson(data) {
  const list = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data)
      ? data
      : [];
  return list.map((s) => ({
    storeCode: String(s.storeCode || ""),
    name: String(s.storeName || s.name || ""),
    address: String(s.address || ""),
    distance: s.distance ?? null,
    beCode: String(s.beCode || ""),
    businessStatus: s.businessStatus ?? null,
    businessStartTime: String(s.businessStartTime || ""),
    businessEndTime: String(s.businessEndTime || ""),
    reservation: s.reservation === true,
    reservationOptions: (s.reservationTimeOptions || []).map((o) => ({
      date: String(o.date || ""),
      today: o.today === true,
      text: String(o.reservationOptionText || ""),
    })),
  }));
}

/**
 * 从 `mall-points-products` 的 data 数组转成契约对象。
 */
export function collectMallItems(data, { now = new Date() } = {}) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  return list.map((it) => {
    const point = num(it.point);
    const face = parseFaceValue(it.spuName, it.price);
    return {
      spuId: num(it.spuId),
      name: String(it.spuName || ""),
      points: point,
      faceValue: face.value,
      faceValueSource: face.source,
      category: String(it.catName || ""),
      shopId: num(it.shopId),
      selling: String(it.selling || ""),
      upAt: it.upTime || null,
      downAt: it.downTime || null,
      status: resolveMallStatus(it.upTime, it.downTime, now),
      imageUrl: String(it.spuImage || it.imageUrl || ""),
    };
  });
}

/**
 * 从 `order-list` 的 data.list 转成契约对象。
 *
 * 注意：整单退款应过滤（不算消费），部分退款仍计入（接口不提供退款额，
 * 只能如实提示「支出可能略偏高」）。0 元订单（券核销/积分兑换）
 * 不计入客单价，但仍算一次点单机会。
 */
export function collectOrders(data) {
  // 实测返回形态：{ success, code, data: { list: [...] } }
  const list = Array.isArray(data?.data?.list)
    ? data.data.list
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data)
        ? data
        : [];
  return list.map((o) => ({
    orderId: String(o.orderId || ""),
    createdAt: String(o.createTime || ""),
    storeCode: String(o.storeCode || ""),
    storeName: String(o.storeName || ""),
    status: String(o.orderStatus || ""),
    // ⚠️ 单位陷阱：`order-list` 的 realTotalAmount 已经是**元**（如 "36.5"），
    //    而 `calculate-price` / `mall-*` 的金额字段是**分**（如 1350）。
    //    两个接口方向相反 —— 这里若也按分换算，36.5 元会变成 0.37 元，
    //    消费画像与客单价全部缩小 100 倍。
    amount: num(o.realTotalAmount),
    items: (o.orderProductList || []).map((p) => ({
      code: String(p.productCode || ""),
      name: String(p.productName || ""),
      quantity: num(p.quantity, 1),
      combo: (p.comboItemList || []).map((c) => ({
        code: String(c.productCode || ""),
        name: String(c.name || ""),
        quantity: num(c.quantity, 1),
      })),
    })),
  }));
}
