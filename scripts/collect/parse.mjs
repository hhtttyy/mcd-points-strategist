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
 * 周一 = 0，周日 = 6。空数组 = 不限。
 */
const WEEKDAY_MAP = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

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

  return {
    ...coupon,
    type,
    stackable,
    daysLeft,
    usableSlots: coupon.usableSlots ?? null,
    isUsableNow,
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
