/**
 * mcd-points-strategist · 数据契约
 *
 * 本文件是**唯一的跨模块数据结构定义处**。任何模块之间传递数据，
 * 都必须使用这里定义的形状；模块不得互相 import 内部实现。
 *
 * 三条硬约束：
 *   1. 契约只描述「形状」，不含业务逻辑、不含 IO。
 *   2. 每个契约都配一个 `validate*` 函数，边界处校验，坏数据早失败。
 *   3. 金额单位统一为「元」。MCP 原始返回是「分」，转换只允许发生在 collect 层。
 *
 * 依赖方向：app → analyze → collect → lib。反向依赖即违规。
 */

// --------------------------------------------------------------------------
// 基础类型
// --------------------------------------------------------------------------

/** 积分账户快照。字段名与 MCP `query-my-account` 的 data 对齐。 */
export const PointsAccount = {
  available: "number", // 可用积分
  accumulative: "number", // 累计获得
  used: "number", // 已使用
  expired: "number", // 已过期 —— 真实发生过的损失
  frozen: "number", // 冻结中
  expiringThisMonth: "number", // 本月将过期
  expiringNextMonth: "number", // 下月将过期
  currency: "string", // 积分单位名，如「麦享会积分」
};

/** 一张优惠券。 */
export const Coupon = {
  id: "string", // 券标识（couponId / couponCode）
  name: "string", // 券面标题
  value: "number", // 券面价值（元）—— 用券可省下的金额
  threshold: "number", // 满减门槛（元），非满减券为 0
  expireAt: "string|null", // 有效期截止 ISO 字符串
  expireText: "string", // 有效期原文（含时段与星期限制）
  dayWindow: "string", // 单日/时段券的可用时段，如 "05:00-10:29"
  weekdays: "number[]", // 可用星期（0=周一），空数组=不限
  weekdayText: "string", // 星期限制的可读描述
  channel: "string[]", // 可用渠道：["pickup"] ["delivery"]，空数组=不限
  validFrom: "string|null", // 生效日
  source: "string", // 来源：mcd-savers | my | store
  status: "string", // 原始状态：可领取 / 已领取 / 已使用
  // —— 以下为引擎附加的派生字段 ——
  type: "string", // 5 类券之一，见 COUPON_TYPES
  itemCodes: "string[]", // 适用商品编码
  stackable: "boolean", // 是否可与其他券叠加（拿不准一律 false）
  daysLeft: "number|null", // 距失效的自然天数
  usableSlots: "number|null", // 真正还能用的时段数（考虑星期与时段限制）
  isUsableNow: "boolean", // 此刻是否可用
};

/** 积分商城标的。 */
export const MallItem = {
  spuId: "number", // 商品 ID
  name: "string", // 标的名
  points: "number", // 所需积分（0 = 现金购买，不属于积分资产）
  faceValue: "number", // 解析出的面值（元）
  faceValueSource: "string", // spuName | priceField | unknown
  category: "string", // 分类
  shopId: "number", // 商城通道：2=积分兑换，5=活动预约
  selling: "string", // 卖点描述
  upAt: "string|null", // 上架时间
  downAt: "string|null", // 下架时间
  status: "string", // live | expired | upcoming
  imageUrl: "string", // 图片
};

/** 营销活动日历的一天。 */
export const Campaign = {
  date: "string", // ISO 日期
  phase: "string", // 原文标签（往期回顾/今日/空）—— 仅记录，不用于判断
  titles: "string[]", // 当天的活动标题
  highlights: "string", // 活动内容介绍原文
};

/** 积分抽奖活动。 */
export const Lottery = {
  name: "string", // 活动名
  status: "string", // 活动状态文本
  drawPoint: "number", // 单次消耗积分
  drawType: "string", // 消耗规则文本
  availablePoint: "number", // 活动内可用积分
  availableTimes: "number|null", // 可抽次数
  beginAt: "string|null", // 开始时间
  endAt: "string|null", // 结束时间
  resourceEligible: "boolean|null", // 是否可参与（以 drawDecision 为准）
  ineligibleReason: "string", // 不可参与原因
  prizes: "object[]", // 奖品列表：{name, type, imageUrl}
};

/** 历史订单（用于消费画像与 earnRate 校准）。 */
export const Order = {
  orderId: "string", // 订单 ID —— 识别「新下单」的关键
  createdAt: "string", // 下单时间
  storeCode: "string", // 门店编码
  storeName: "string", // 门店名
  status: "string", // 订单状态（订单已完成/部分退款/整单退款…）
  amount: "number", // 实付金额（元）
  items: "object[]", // 商品列表
};

/** 门店。 */
export const Store = {
  storeCode: "string", // 门店编码
  name: "string", // 门店名
  address: "string", // 地址
  distance: "number|null", // 距离（米）
};

/** 门店级促销（来自未在官方文档中的 query-promotions）。 */
export const Promotion = {
  title: "string", // 促销标题
  description: "string", // 描述原文
};

/** 完整快照 —— 采集层的唯一产出，也是巡检 diff 的比较基准。 */
export const Snapshot = {
  generatedAt: "string", // 采集时间 ISO
  source: "string", // 数据来源说明
  account: "object|null", // PointsAccount
  mall: "object[]", // MallItem[]
  coupons: "object[]", // Coupon[]
  campaigns: "object[]", // Campaign[]
  lottery: "object|null", // Lottery
  orders: "object[]", // Order[]
  stores: "object[]", // Store[]
  promotions: "object[]", // Promotion[]
  errors: "object[]", // 采集失败项：{tool, error}
};

// --------------------------------------------------------------------------
// 5 类券
// --------------------------------------------------------------------------

/**
 * 券类型抽象（借 mcd-saver-strategist 的 coupon-strategy.md）。
 *
 * 判不准时**降级为 threshold 或忽略该券**，并在输出中说明
 * 「该券规则无法自动核算，已按单点计」，绝不猜一个价格。
 */
export const COUPON_TYPES = {
  item_price: "单品改价：把某商品价格改成固定值",
  percent: "单品折扣：对匹配商品打折",
  threshold: "满减：小计达标才减",
  bundle_price: "组合价：每组各挑 1 个，打包固定价",
  free_gift: "赠品：达标送商品，不影响价格",
};

// --------------------------------------------------------------------------
// 校验器
// --------------------------------------------------------------------------

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function check(obj, spec, path) {
  const bad = [];
  for (const [key, type] of Object.entries(spec)) {
    const v = obj?.[key];
    if (type === "number") {
      if (!isNum(v)) bad.push(`${path}.${key} 期望 number，实得 ${JSON.stringify(v)}`);
    } else if (type === "string") {
      if (typeof v !== "string") bad.push(`${path}.${key} 期望 string，实得 ${JSON.stringify(v)}`);
    } else if (type === "boolean") {
      if (typeof v !== "boolean") bad.push(`${path}.${key} 期望 boolean，实得 ${JSON.stringify(v)}`);
    } else if (type === "string[]") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        bad.push(`${path}.${key} 期望 string[]，实得 ${JSON.stringify(v)}`);
      }
    } else if (type === "number[]") {
      if (!Array.isArray(v) || v.some((x) => !isNum(x))) {
        bad.push(`${path}.${key} 期望 number[]，实得 ${JSON.stringify(v)}`);
      }
    } else if (type === "object[]") {
      if (!Array.isArray(v)) bad.push(`${path}.${key} 期望 object[]，实得 ${JSON.stringify(v)}`);
    } else if (type === "object") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        bad.push(`${path}.${key} 期望 object，实得 ${JSON.stringify(v)}`);
      }
    } else if (type === "string|null") {
      if (v !== null && typeof v !== "string") {
        bad.push(`${path}.${key} 期望 string|null，实得 ${JSON.stringify(v)}`);
      }
    } else if (type === "number|null") {
      if (v !== null && !isNum(v)) {
        bad.push(`${path}.${key} 期望 number|null，实得 ${JSON.stringify(v)}`);
      }
    } else if (type === "object|null") {
      if (v !== null && (typeof v !== "object" || Array.isArray(v))) {
        bad.push(`${path}.${key} 期望 object|null，实得 ${JSON.stringify(v)}`);
      }
    }
  }
  return bad;
}

export function validateAccount(a) {
  return check(a ?? {}, PointsAccount, "account");
}

export function validateCoupon(c) {
  return check(c ?? {}, Coupon, "coupon");
}

export function validateMallItem(m) {
  return check(m ?? {}, MallItem, "mallItem");
}

export function validateOrder(o) {
  return check(o ?? {}, Order, "order");
}

export function validateSnapshot(s) {
  return check(s ?? {}, Snapshot, "snapshot");
}

/**
 * 一次性校验整个快照，返回问题列表（空数组 = 通过）。
 * 用于采集层出口处把关，坏数据不流向下游。
 */
export function validateSnapshotDeep(snap) {
  const problems = [...validateSnapshot(snap)];
  if (snap.account) problems.push(...validateAccount(snap.account));
  (snap.coupons || []).forEach((c, i) => problems.push(...validateCoupon(c)));
  (snap.mall || []).forEach((m, i) => problems.push(...validateMallItem(m)));
  (snap.orders || []).forEach((o, i) => problems.push(...validateOrder(o)));
  return problems;
}

// --------------------------------------------------------------------------
// 券类型判定
// --------------------------------------------------------------------------

/**
 * 判定券属于 5 类中的哪一类。
 *
 * 判定顺序不可调换 —— 越具体的规则越靠前。
 * 判不准时返回 "threshold"（保守：按门槛券处理，倾向于低估优惠）。
 *
 * 关键区分：**「买一送一」是组合价（同一商品打包），「买A送B」是赠品（不同商品）**。
 * 「中薯条买一送一」是 bundle_price，「买汉堡送香芋派」是 free_gift。
 */
export function classifyCoupon(coupon) {
  const name = String(coupon?.name || "");
  const text = `${name} ${coupon?.selling || ""}`;

  // 1. 买一送一 / 买1送1 —— 同一商品打包，属组合价
  if (/买\s*[一1]\s*送\s*[一1]/.test(text)) return "bundle_price";
  // 2. 买A送B（不同商品）/ 赠品 / 免费得 —— 赠品不影响价格
  if (/买[^送]{1,10}送|赠品|免费得|免费送|加赠|赠送/.test(text)) return "free_gift";
  // 3. 满 X 减 Y / 立减
  if (/满\s*[\d.]+\s*减|立减|减\s*[\d.]+\s*元/.test(text)) return "threshold";
  // 4. 1+1 / 随心配 / 套餐价 / 任选 N 件 X 元
  if (/1\+1|随心配|套餐价|任选|任你选|二选一/.test(text)) return "bundle_price";
  // 5. 某单品 X 元（固定价）
  if (/^[\d.]+\s*元/.test(name)) return "item_price";
  // 6. 某商品 X 折
  if (/[\d.]+\s*折/.test(text)) return "percent";
  // 兜底：保守处理
  return "threshold";
}
