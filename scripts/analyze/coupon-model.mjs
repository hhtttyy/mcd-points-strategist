/**
 * mcd-points-strategist · 券建模
 *
 * 把麦当劳五花八门的优惠券统一抽象成**可计算的 5 类券**。
 *
 * 为什么要建模：券名是自然语言（「中薯条买一送一」「王牌小食拼」），
 * 不建模就只能做字符串匹配 —— 那是「领得准」的反面。
 *
 * 建模后的每一张券都能回答：
 *   - 它能省多少钱（value）
 *   - 它在什么条件下生效（threshold / dayWindow / weekdays / channel）
 *   - 它能不能和别的券叠加（stackable / conflict）
 *   - 它值不值得为它凑单（marginalCost）
 *
 * 本模块是纯函数，不碰 IO。
 */

import { classifyCoupon } from "../lib/schema.mjs";

// --------------------------------------------------------------------------
// 券类型常量
// --------------------------------------------------------------------------

export const COUPON_TYPES = {
  item_price: "单品改价：把某商品价格改成固定值",
  percent: "单品折扣：对匹配商品打折",
  threshold: "满减：小计达标才减",
  bundle_price: "组合价：每组各挑 1 个，打包固定价",
  free_gift: "赠品：达标送商品，不影响价格",
};

/** 5 类券的判定顺序（不可调换，越具体越靠前）。 */
const CLASSIFY_RULES = [
  { type: "bundle_price", re: /买\s*[一1]\s*送\s*[一1]/, why: "买一送一 —— 同一商品打包" },
  { type: "free_gift", re: /买[^送]{1,10}送|赠品|免费得|免费送|加赠|赠送/, why: "买A送B —— 不同商品，属赠品" },
  { type: "threshold", re: /满\s*[\d.]+\s*减|立减|减\s*[\d.]+\s*元/, why: "满减门槛" },
  { type: "bundle_price", re: /1\+1|随心配|套餐价|任选|任你选|二选一/, why: "组合/任选价" },
  { type: "item_price", re: /^[\d.]+\s*元/, why: "单品固定价" },
  { type: "percent", re: /[\d.]+\s*折/, why: "单品折扣" },
];

/**
 * 判定券类型，并说明判定依据。
 *
 * 判不准时降级为 `threshold` 并标记 `confident: false` ——
 * 宁可少报优惠，也不给用户一个到店里付不出来的「假便宜」。
 */
export function classify(coupon) {
  const name = String(coupon?.name || "");
  const text = `${name} ${coupon?.selling || ""}`;
  for (const rule of CLASSIFY_RULES) {
    if (rule.re.test(text)) {
      return { type: rule.type, confident: true, reason: rule.why };
    }
  }
  return {
    type: "threshold",
    confident: false,
    reason: "券面规则无法自动识别，已保守按门槛券处理（倾向于低估优惠）",
  };
}

// --------------------------------------------------------------------------
// 券面解析：从自然语言里抽出可计算参数
// --------------------------------------------------------------------------

const YUAN = /([\d.]+)\s*元/g;
const FEN = /([\d.]+)\s*折/g;

/**
 * 从券面文字里抽取面额、折扣、门槛、适用商品。
 *
 * 注意：`value` 是**券面标称价值**，不是实际到手价值。
 * 实测「王牌小食拼」标题里没有数字，从菜单反查原价只能得到 0，
 * 但用 `calculate-price` 实测能拿到真实的 6.6 元 ——
 * 所以本函数抽不出值时**如实标 0 并记下 unknown**，不编造。
 */
export function parseCouponTerms(coupon) {
  const name = String(coupon?.name || "");
  const selling = String(coupon?.selling || "");
  const text = `${name} ${selling}`;

  const out = {
    faceValue: 0, // 券面标称价值（元）
    discountPct: 0, // 折扣率（0.5 = 5 折），0 表示无折扣
    threshold: 0, // 门槛（元）
    itemCodes: [], // 适用商品编码
    groups: [], // 组合券的分组
    unknown: false, // 面值是否无法确定
  };

  // 门槛：满 X 减 Y
  const th = text.match(/满\s*([\d.]+)\s*元?\s*减\s*([\d.]+)\s*元?/);
  if (th) {
    out.threshold = num(th[1]);
    out.faceValue = num(th[2]);
    return out;
  }

  // 立减 X 元
  const ld = text.match(/立减\s*([\d.]+)\s*元/);
  if (ld) {
    out.faceValue = num(ld[1]);
    return out;
  }

  // 组合价：N 元任选 / 套餐价 X 元
  const bundle = text.match(/([\d.]+)\s*元\s*任选|套餐价\s*([\d.]+)\s*元/);
  if (bundle) {
    out.faceValue = num(bundle[1] || bundle[2]);
    return out;
  }

  // 折扣：X 折
  const fold = text.match(/([\d.]+)\s*折/);
  if (fold) {
    const rate = num(fold[1]) / 10;
    out.discountPct = rate > 0 && rate < 1 ? rate : 0;
    return out;
  }

  // 单品固定价：名字以「X元」开头
  const fixed = name.match(/^([\d.]+)\s*元/);
  if (fixed) {
    out.faceValue = num(fixed[1]);
    return out;
  }

  // 兜底：抓所有「X元」里的最大值作为面额参考
  const yuans = [...text.matchAll(YUAN)].map((m) => num(m[1])).filter((v) => v > 0);
  if (yuans.length) {
    out.faceValue = Math.max(...yuans);
    out.unknown = true; // 知道面值但不知道对应哪个商品
    return out;
  }

  out.unknown = true;
  return out;
}

// --------------------------------------------------------------------------
// 叠加与互斥
// --------------------------------------------------------------------------

/**
 * 判断两张券是否互斥（不可同时使用）。
 *
 * 保守策略 —— 宁可少省也不多算：
 *   - 拿不准 `stackable` 时一律视为互斥（默认 false）
 *   - 两张满减/赠品类券可叠加（门槛不同则互不干扰）
 *   - 作用于同一商品的两张券互斥（不能把同一份薯条打两次折）
 */
export function conflicts(a, b) {
  const sa = a.stackable === true;
  const sb = b.stackable === true;
  if (!sa || !sb) return true;

  const ta = a.type;
  const tb = b.type;
  // 满减与赠品可叠加
  if (isThresholdLike(ta) && isThresholdLike(tb)) return false;

  // 作用于同一商品 → 互斥
  const ca = itemScope(a);
  const cb = itemScope(b);
  if (ca.length && cb.length && ca.some((c) => cb.includes(c))) return true;

  return false;
}

function isThresholdLike(t) {
  return t === "threshold" || t === "free_gift";
}

function itemScope(c) {
  const s = new Set(c.itemCodes || []);
  for (const g of c.groups || []) for (const code of g) s.add(code);
  return [...s];
}

/**
 * 从一组券里找出所有**互不冲突的最大组合**。
 *
 * 券不多（实测卡包 9 张），穷举子集是可行的（2^9 = 512）。
 * 返回按「可叠加张数」降序的所有可行组合，便于上层选最优。
 */
export function findCompatibleSets(coupons, limit = 32) {
  const list = (coupons || []).filter(Boolean);
  if (!list.length) return [];

  const n = list.length;
  const sets = [];

  for (let mask = 0; mask < 1 << n; mask++) {
    const picked = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) picked.push(list[i]);
    }
    if (!picked.length) continue;

    let ok = true;
    for (let i = 0; i < picked.length && ok; i++) {
      for (let j = i + 1; j < picked.length && ok; j++) {
        if (conflicts(picked[i], picked[j])) ok = false;
      }
    }
    if (ok) sets.push(picked);
  }

  sets.sort((a, b) => b.length - a.length);
  return sets.slice(0, limit);
}

// --------------------------------------------------------------------------
// 适用性判定
// --------------------------------------------------------------------------

/**
 * 券在某个场景下能不能用。
 *
 * 四个维度同时判定，缺一不可：
 *   - 到账状态：已领取 / 可领取
 *   - 有效期：是否已过期、是否已生效
 *   - 时段：dayWindow（如早餐券 05:00-10:29）
 *   - 渠道：pickup / delivery
 *
 * @param {object} coupon
 * @param {object} ctx
 * @param {string} [ctx.at]          判定时刻 ISO
 * @param {string} [ctx.channel]     "pickup" | "delivery"
 * @returns {{ok: boolean, reason: string}}
 */
export function checkUsable(coupon, ctx = {}) {
  const at = ctx.at ? new Date(ctx.at) : new Date();
  const name = coupon?.name || "这张券";

  if (coupon.status === "可领取") {
    return { ok: false, reason: "尚未领取到卡包，需先领" };
  }
  if (coupon.expireAt && new Date(coupon.expireAt) < at) {
    return { ok: false, reason: "已过期" };
  }
  if (coupon.validFrom && new Date(coupon.validFrom) > at) {
    return { ok: false, reason: `尚未生效（${fmtDate(coupon.validFrom)} 起）` };
  }
  if (ctx.channel && coupon.channel?.length) {
    const label = ctx.channel === "pickup" ? "到店" : "外送";
    if (!coupon.channel.includes(ctx.channel)) {
      const only = coupon.channel.map((c) => (c === "pickup" ? "到店" : "外送")).join("、");
      return { ok: false, reason: `仅限${only}使用，当前是${label}` };
    }
  }
  if (ctx.hour !== undefined && coupon.dayWindow) {
    const w = parseWindow(coupon.dayWindow);
    if (w && !w.contains(ctx.hour)) {
      return { ok: false, reason: `可用时段 ${coupon.dayWindow}，当前不在时段内` };
    }
  }
  // ⚠️ 星期判定（此前完全缺失）。
  //    实测（2026-10-23）：券的 `weekdays` = 周一~周五，
  //    而周六它其实不能用 —— 但看板只说「仅 N 天能用」，
  //    没说「哪几天能用」，用户会以为每天都能用。
  //
  //    编码：0=周日（与 collect 层转换后一致，与 JS getDay() 一致）。
  if (coupon.weekdays?.length) {
    const dow = at.getDay();
    if (!coupon.weekdays.includes(dow)) {
      const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      return {
        ok: false,
        reason: `仅限${coupon.weekdayText || coupon.weekdays.map((w) => WD[w]).join("、")}使用，今天是${WD[dow]}`,
      };
    }
  }
  return { ok: true, reason: "" };
}

/** 解析 "05:00-10:29" 这样的时段。 */
export function parseWindow(text) {
  const m = String(text || "").match(/(\d{1,2}):(\d{2})\s*[-–~]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return {
    start,
    end,
    contains(hour) {
      const h = hour * 60;
      return h >= start && h <= end;
    },
  };
}

// --------------------------------------------------------------------------
// 可用时段计算 —— 「还剩 4 天」≠「有 4 天能用」
// --------------------------------------------------------------------------

/**
 * 计算一张券在有效期内**真正还能用几天**。
 *
 * 这是本项目「不错过券」的核心：只报剩余天数会误导用户。
 * 早餐券写着「还剩 1 天」，但它只在 05:00-10:29 能用；
 * 工作日券写着「还剩 4 天」，但周末完全用不了。
 *
 * @param {object} coupon
 * @param {object} opts
 * @param {Date}   [opts.now]
 * @param {number} [opts.horizonDays] 最多往后看多少天（默认 90）
 */
export function computeUsableSlots(coupon, { now = new Date(), horizonDays = 90 } = {}) {
  const expireAt = coupon?.expireAt ? new Date(coupon.expireAt) : null;
  const validFrom = coupon?.validFrom ? new Date(coupon.validFrom) : null;
  const weekdays = coupon?.weekdays || [];

  // 没有截止日 → 期限未知。不能当成「无期限」。
  if (!expireAt) {
    return {
      usableDays: null,
      unusableDays: null,
      expired: false,
      unknown: true,
      note: "期限未知（未领取的券拿不到有效期）",
    };
  }

  const start = new Date(now);
  if (validFrom && validFrom > start) start.setTime(validFrom.getTime());

  const end = new Date(expireAt);
  let usableDays = 0;
  let unusableDays = 0;
  let total = 0;

  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= end && total < horizonDays) {
    total += 1;
    // ⚠️ 统一用 **0=周日**（JS `getDay()` 原生语义）。
    //    券的 weekdays 数组在 collect 层已从「1=周日」转换到「0=周日」，
    //    这里必须用同一套编码 —— 早期版本这里用「0=周一」，
    //    与 collect 层的「0=周日」差一天，导致每个周末和周一都判错。
    const dow = cursor.getDay();
    if (weekdays.length && !weekdays.includes(dow)) {
      unusableDays += 1;
    } else {
      usableDays += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    usableDays,
    unusableDays,
    totalDays: total,
    expired: end < now,
    unknown: false,
    note: "",
  };
}

// --------------------------------------------------------------------------
// 凑单边际成本
// --------------------------------------------------------------------------

/**
 * 为用这张券凑单是否划算。
 *
 * 核心：为了用「满 35 减 7」而加购一件 ¥9 的东西，
 * 净效果 = 9 - 7 = **+2 元** → 不划算。
 * 加购 ¥5 的东西，净省 2 元 → 划算。
 *
 * @param {object} coupon
 * @param {number} subtotal 当前小计（元）
 * @param {Array}  menu     可加购商品 [{code, name, price}]
 * @param {number} [topUpLimit] 最多加购多少钱
 */
export function analyzeFiller(coupon, subtotal, menu = [], { topUpLimit = 20 } = {}) {
  const threshold = coupon?.threshold || 0;
  const discount = coupon?.faceValue || 0;

  if (!threshold || !discount) {
    return { needed: 0, marginalCost: 0, worthwhile: false, reason: "该券无门槛，无需凑单" };
  }
  if (subtotal >= threshold) {
    return {
      needed: 0,
      marginalCost: 0,
      worthwhile: true,
      reason: `小计 ¥${subtotal} 已过门槛 ¥${threshold}，直接可用`,
    };
  }

  // 必须补齐到门槛的金额
  const gap = round(threshold - subtotal);
  // 净多花 = 补的钱 - 券省的钱。补 ¥9 换 ¥7 → 净多花 ¥2
  const marginalCost = round(gap - discount);

  // 找一个能真正跨过门槛（价格 ≥ gap）且不超 topUpLimit 的商品
  const candidates = (menu || [])
    .filter((it) => it.price > 0 && it.price <= topUpLimit)
    .sort((a, b) => a.price - b.price);
  const filler = candidates.find((it) => it.price >= gap) || null;

  return {
    needed: gap,
    marginalCost,
    worthwhile: marginalCost <= 0,
    reason:
      marginalCost <= 0
        ? `再消费 ¥${gap} 即可跨过门槛，净省 ¥${-marginalCost}`
        : `为用这张券至少要再消费 ¥${gap}，但券只省 ¥${discount}，净多花 ¥${marginalCost} —— 不划算`,
    filler: filler ? { code: filler.code, name: filler.name, price: filler.price } : null,
  };
}

// --------------------------------------------------------------------------
// 工具
// --------------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round(v * f) / f;
}

function fmtDate(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
