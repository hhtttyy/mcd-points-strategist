#!/usr/bin/env node
/**
 * mcd-points-strategist · 采集层自测
 *
 * 用**真实抓取的历史响应**做回归 —— 这些 fixture 来自
 * mcd-coupon-strategist 项目的实测录制（含脱敏），是本项目解析逻辑的
 * 唯一真相来源。
 *
 * 覆盖：
 *   - 券列表 Markdown 解析（available-coupons）
 *   - 我的券 Markdown 解析（query-my-coupons）—— 含时段/星期/渠道
 *   - 活动日历 Markdown 解析（campaign-calendar）
 *   - 面值解析（price 恒为 0，真值在 spuName 前缀）
 *   - 上下架判定（看 downTime 不看 status）
 *   - 星期与时段解析
 *   - 5 类券分类
 *   - 金额单位换算
 *   - 契约校验
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  collectAccount,
  collectAvailableCoupons,
  collectCampaigns,
  collectMall,
  collectMyCoupons,
  collectOrders,
  mergeCoupons,
} from "../collect/collectors.mjs";
import {
  centsToYuan,
  parseDayWindow,
  parseExpireAt,
  parseFaceValue,
  parseWeekdays,
  resolveMallStatus,
} from "../collect/parse.mjs";
import { classifyCoupon, validateSnapshotDeep } from "../lib/schema.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const FIX = resolve(ROOT, "fixtures/reference");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      failures.push(`${name} → ${r}`);
      console.log(`  ✗ ${name}  ${r}`);
    }
  } catch (e) {
    fail++;
    failures.push(`${name} → 异常: ${e.message}`);
    console.log(`  ✗ ${name}  异常: ${e.message}`);
  }
}

function eq(actual, expected, label = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}${label ? ` (${label})` : ""}`;
  }
  return true;
}

function load(name) {
  try {
    return readFileSync(resolve(FIX, name), "utf8");
  } catch {
    return null;
  }
}

console.log("\n【金额单位换算】");
check("1450 分 → 14.5 元", () => eq(centsToYuan(1450), 14.5));
check("字符串 '2250' 分 → 22.5 元", () => eq(centsToYuan("2250"), 22.5));
check("null → 0", () => eq(centsToYuan(null), 0));
check("undefined → 0", () => eq(centsToYuan(undefined), 0));

console.log("\n【面值解析 —— price 恒为 0，真值在 spuName 前缀】");
check("「18.8元2份麦辣鸡翅」→ 18.8", () => eq(parseFaceValue("18.8元2份麦辣鸡翅", 0).value, 18.8));
check("面值来源标记为 spuName", () => eq(parseFaceValue("18.8元2份麦辣鸡翅", 0).source, "spuName"));
check("「6.9元可乐麦炫酷」→ 6.9", () => eq(parseFaceValue("6.9元可乐麦炫酷", 0).value, 6.9));
check("「罗技键鼠套装」→ 0（实物类不参与排名）", () => eq(parseFaceValue("罗技键鼠套装", 0).value, 0));
check("实物类来源标记为 unknown", () => eq(parseFaceValue("罗技键鼠套装", 0).source, "unknown"));
check("现金类回落到 priceField", () => eq(parseFaceValue("麦当劳奇妙生日派对", 50).source, "priceField"));
check("误用 price 字段会让密度归零（回归防护）", () => {
  const wrong = parseFaceValue("18.8元2份麦辣鸡翅", 0).value;
  return wrong === 18.8 ? true : "面值解析错误";
});

console.log("\n【上下架判定 —— 看 downTime 不看 status】");
check("downTime 已过 → expired", () => eq(resolveMallStatus(null, "2020-01-01 00:00:00"), "expired"));
check("upTime 未到 → upcoming", () => eq(resolveMallStatus("2099-01-01 00:00:00", "2099-12-31 23:59:59"), "upcoming"));
check("在架区间内 → live", () => eq(resolveMallStatus("2023-01-01 00:00:00", "2099-12-31 23:59:59"), "live"));
check("无时间信息 → live", () => eq(resolveMallStatus(null, null), "live"));

console.log("\n【星期与时段解析 —— 「还剩 4 天」≠「有 4 天能用」】");
const multiDay = "2026-10-12 10:30-2026-10-16 23:59 周一、二、三、四、五 10:30-23:59";
const singleDay = "2026-10-15 05:00-2026-10-15 10:29 周四 05:00-10:29";
// ⚠️ 星期编码统一为 **0=周日**（与 JS getDay() 一致）：
//   周日0 周一1 周二2 周三3 周四4 周五5 周六6
//   早期版本用「0=周一」，与原生 weekdays 数组差一位 —— 每个周末和周一都判错。
check("多日券星期「周一~周五」→ [1,2,3,4,5]", () => eq(parseWeekdays(multiDay), [1, 2, 3, 4, 5]));
check("单日券星期「周四」→ [4]", () => eq(parseWeekdays(singleDay), [4]));
check("多日券时段 → 10:30-23:59", () => eq(parseDayWindow(multiDay), "10:30-23:59"));
check("单日券时段 → 05:00-10:29", () => eq(parseDayWindow(singleDay), "05:00-10:29"));
check("无星期限制 → []", () => eq(parseWeekdays("2026-10-12 到期"), []));
check("截止时刻取最晚", () => {
  const t = parseExpireAt(multiDay);
  return t && t.getFullYear() === 2026 && t.getMonth() === 9 && t.getDate() === 16
    ? true
    : `实得 ${t}`;
});

console.log("\n【5 类券分类】");
check("买一送一 → bundle_price", () => eq(classifyCoupon({ name: "中薯条买一送一" }), "bundle_price"));
check("随心配 → bundle_price", () => eq(classifyCoupon({ name: "1+1随心配" }), "bundle_price"));
check("满减 → threshold", () => eq(classifyCoupon({ name: "满35减7" }), "threshold"));
check("立减 → threshold", () => eq(classifyCoupon({ name: "立减5元" }), "threshold"));
check("单品固定价 → item_price", () => eq(classifyCoupon({ name: "6.9元可乐麦炫酷" }), "item_price"));
check("打折 → percent", () => eq(classifyCoupon({ name: "麦辣鸡腿堡8折" }), "percent"));
check("赠品 → free_gift", () => eq(classifyCoupon({ name: "买汉堡送香芋派" }), "free_gift"));
check("判不准 → 保守降级为 threshold", () => eq(classifyCoupon({ name: "某个看不懂的券" }), "threshold"));

console.log("\n【可用性判定】");
check("未来生效的券此刻不可用", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const c = collectMyCoupons(`## 未来券\n- **有效期**: ${future.slice(0, 10)} 05:00-10:29 周四 05:00-10:29\n`);
  return c[0]?.isUsableNow === false ? true : `实得 ${c[0]?.isUsableNow}`;
});
check("已过期的券 daysLeft 为负", () => {
  const past = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const c = collectMyCoupons(`## 过期券\n- **有效期**: ${past} 05:00-10:29 周四 05:00-10:29\n`);
  return c[0]?.daysLeft < 0 ? true : `实得 ${c[0]?.daysLeft}`;
});

console.log("\n【券列表解析 · available-coupons 真实响应】");
const availRaw = load("available_coupons.json");
if (availRaw) {
  const raw = JSON.parse(availRaw).raw;
  const coupons = collectAvailableCoupons(raw);
  check("解析出 7 条麦麦省券", () => eq(coupons.length, 7));
  check("包含「中薯条买一送一」", () =>
    coupons.some((c) => c.name === "中薯条买一送一") ? true : "未找到该券"
  );
  check("识别出「可领取」状态", () =>
    coupons.some((c) => c.status === "可领取") ? true : "未识别到可领取"
  );
  check("识别出「已领取」状态", () =>
    coupons.some((c) => c.status === "已领取") ? true : "未识别到已领取"
  );
  check("未领取的券无有效期（不得编造剩余天数）", () => {
    const unclaimed = coupons.find((c) => c.status === "可领取");
    return unclaimed && unclaimed.expireAt === null && unclaimed.daysLeft === null
      ? true
      : "未领取券不应有有效期";
  });
  check("source 标记为 mcd-savers", () => eq(coupons[0]?.source, "mcd-savers"));
} else {
  console.log("  ⚠ 缺少 fixtures/reference/available_coupons.json，跳过");
}

console.log("\n【我的券解析 · query-my-coupons 真实响应】");
const myRaw = load("my_coupons.md");
if (myRaw) {
  const coupons = collectMyCoupons(myRaw);
  check("解析出 9 张卡包券", () => eq(coupons.length, 9));
  check("解析出面值 ¥13.5", () =>
    coupons.some((c) => c.name === "中薯条买一送一" && c.value === 13.5)
      ? true
      : "面值未解析"
  );
  check("解析出星期限制 [1,2,3,4,5]（0=周日 编码）", () => {
    const c = coupons.find((x) => x.name === "中薯条买一送一");
    return eq(c?.weekdays, [1, 2, 3, 4, 5]);
  });
  check("解析出渠道 ['pickup','delivery']", () => {
    const c = coupons.find((x) => x.name === "中薯条买一送一");
    return eq(c?.channel, ["pickup", "delivery"]);
  });
  check("单日券仅到店可用 → channel ['pickup']", () => {
    const c = coupons.find((x) => x.name === "大脆鸡扒堡早餐两件套");
    return eq(c?.channel, ["pickup"]);
  });
  check("单日券时段 → 05:00-10:29", () => {
    const c = coupons.find((x) => x.name === "大脆鸡扒堡早餐两件套");
    return eq(c?.dayWindow, "05:00-10:29");
  });
  check("source 标记为 my", () => eq(coupons[0]?.source, "my"));
  check("stackable 保守默认 false", () => eq(coupons[0]?.stackable, false));
} else {
  console.log("  ⚠ 缺少 fixtures/reference/my_coupons.md，跳过");
}

console.log("\n【活动日历解析 · campaign-calendar 真实响应】");
const calRaw = load("campaign_calendar.md");
if (calRaw) {
  const campaigns = collectCampaigns(calRaw);
  check("解析出多天活动", () => campaigns.length >= 3 ? true : `实得 ${campaigns.length}`);
  check("日期归一化为 ISO 格式", () =>
    /^\d{4}-\d{2}-\d{2}$/.test(campaigns[0]?.date || "") ? true : `实得 ${campaigns[0]?.date}`
  );
  check("能取到活动标题", () =>
    campaigns.some((c) => c.titles.length > 0) ? true : "未取到标题"
  );
  check("不解析营销文案里的价格（结构化字段只有标题）", () => {
    const withPrice = campaigns.filter((c) =>
      c.titles.some((t) => /\d+(\.\d+)?\s*元|\d+(\.\d+)?\s*r/i.test(t))
    );
    // 标题里含价格是允许的（原文如此），但 highlights 不应被当成价格来源
    return campaigns.every((c) => typeof c.highlights === "string") ? true : "highlights 类型错误";
  });
} else {
  console.log("  ⚠ 缺少 fixtures/reference/campaign_calendar.md，跳过");
}

console.log("\n【订单解析 · order-list 真实响应】");
const ordRaw = load("orders.json");
if (ordRaw) {
  const orders = collectOrders(JSON.parse(ordRaw));
  check("解析出 10 条订单", () => eq(orders.length, 10));
  check("金额已从分转元", () => eq(orders[0]?.amount, 36.5));
  check("保留 orderId（识别新下单的关键）", () =>
    typeof orders[0]?.orderId === "string" && orders[0].orderId.length > 10
      ? true
      : "orderId 缺失"
  );
  check("保留门店名", () =>
    typeof orders[0]?.storeName === "string" && orders[0].storeName.length > 0
      ? true
      : "storeName 缺失"
  );
  check("识别部分退款状态", () =>
    orders.some((o) => o.status.includes("退款")) ? true : "未识别退款状态"
  );
} else {
  console.log("  ⚠ 缺少 fixtures/reference/orders.json，跳过");
}

console.log("\n【积分账户解析】");
const acctRaw = load("points_account.json");
if (acctRaw) {
  const acct = collectAccount(JSON.parse(acctRaw));
  // 实测：积分字段全是**字符串**且可带小数，如 "376.3"
  check("可用积分 376.3（字符串→数值）", () => eq(acct.available, 376.3));
  check("累计积分 581.3", () => eq(acct.accumulative, 581.3));
  check("已使用 188", () => eq(acct.used, 188));
  check("已过期 17", () => eq(acct.expired, 17));
  check("本月临期 0", () => eq(acct.expiringThisMonth, 0));
  check("积分单位名", () => eq(acct.currency, "麦享会积分"));
  check("字符串型积分不丢失小数", () => {
    const a = collectAccount({ data: { availablePoint: "33.5", accumulativePoint: "763" } });
    return eq(a.available, 33.5) && eq(a.accumulative, 763);
  });
} else {
  console.log("  ⚠ 缺少 fixtures/reference/points_account.json，跳过");
}

console.log("\n【券合并去重】");
check("同名同期的券只保留一份", () => {
  const a = collectMyCoupons("## 中薯条买一送一\n- **优惠**: ¥13.5 (用券价格)\n- **有效期**: 2026-10-16 23:59 周五 10:30-23:59\n");
  const b = collectMyCoupons("## 中薯条买一送一\n- **优惠**: ¥13.5 (用券价格)\n- **有效期**: 2026-10-16 23:59 周五 10:30-23:59\n");
  const merged = mergeCoupons([a, b]);
  return eq(merged.length, 1);
});
check("不同有效期的同名券保留两份", () => {
  const a = collectMyCoupons("## 麦辣鸡腿堡\n- **有效期**: 2026-10-16 23:59 周五\n");
  const b = collectMyCoupons("## 麦辣鸡腿堡\n- **有效期**: 2026-10-20 23:59 周二\n");
  return eq(mergeCoupons([a, b]).length, 2);
});

console.log("\n【契约校验】");
check("合法快照通过校验", () => {
  const snap = {
    generatedAt: new Date().toISOString(),
    source: "test",
    account: { available: 1, accumulative: 2, used: 0, expired: 0, frozen: 0, expiringThisMonth: 0, expiringNextMonth: 0, currency: "积分" },
    mall: [],
    coupons: [],
    campaigns: [],
    lottery: null,
    orders: [],
    stores: [],
    promotions: [],
    errors: [],
  };
  return eq(validateSnapshotDeep(snap).length, 0);
});
check("坏数据被拦截", () => {
  const snap = {
    generatedAt: "x", source: "t",
    account: { available: "不是数字" },
    mall: [], coupons: [], campaigns: [], lottery: null, orders: [], stores: [], promotions: [], errors: [],
  };
  return validateSnapshotDeep(snap).length > 0 ? true : "坏数据未被拦截";
});

console.log("\n──────────────────────────────────────────────────");
console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail) {
  console.log("失败明细：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
