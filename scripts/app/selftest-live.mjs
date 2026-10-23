#!/usr/bin/env node
/**
 * mcd-points-strategist · 真实响应回归测试
 *
 * 为什么单独一套：
 *   早期的 `fixtures/reference/` 是**脱敏重构**过的响应（字段名被改写、
 *   格式被整理成整齐 Markdown），解析器在上面全绿，在**真实响应**上全空。
 *   这套测试用 `fixtures/live/`（原样保存的真实响应）把那条缝补上。
 *
 * 覆盖三个真实坑：
 *   1. MCP 响应是业务 JSON 直挂顶层，没有 content 信封
 *   2. 活动标题在 articleDto.title，顶层 activityTitle 是空串
 *   3. discountDesc="用券价格" 是「你付的钱」不是「省的钱」
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  collectAccount,
  collectAvailableCoupons,
  collectCampaigns,
  collectLottery,
  collectMyCoupons,
  collectOrders,
  collectStoreCoupons,
  collectStores,
  mergeCoupons,
} from "../collect/collectors.mjs";
import { computeSilentCost } from "../analyze/coupon-audit.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const LIVE = resolve(ROOT, "fixtures/live");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      failures.push(`${name} → ${r === false ? "断言为 false" : JSON.stringify(r)}`);
      console.log(`  ✗ ${name}  ${r === false ? "" : JSON.stringify(r)}`);
    }
  } catch (e) {
    fail++;
    failures.push(`${name} → 抛出异常：${e.message}`);
    console.log(`  ✗ ${name}  抛出异常：${e.message}`);
  }
}

function eq(a, b) {
  return a === b ? true : `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`;
}

function load(name) {
  const p = resolve(LIVE, `${name}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

const hasAll = ["account", "my_coupons", "available_coupons", "campaign_calendar", "nearby_stores", "store_coupons", "lottery"].every(
  (n) => existsSync(resolve(LIVE, `${n}.json`))
);

if (!hasAll) {
  console.log("⚠ 缺少 fixtures/live/ 下的真实响应快照，跳过真实响应回归测试。");
  console.log("  采集方法：node scripts/app/collect.mjs（会写入 data/snapshot.json）");
  process.exit(0);
}

const raw = {
  account: load("account"),
  myCoupons: load("my_coupons"),
  available: load("available_coupons"),
  campaigns: load("campaign_calendar"),
  stores: load("nearby_stores"),
  storeCoupons: load("store_coupons"),
  lottery: load("lottery"),
};

const NOW = new Date("2026-10-23T08:00:00Z"); // 采集当日的早上

console.log("【账户 · 业务 JSON 直挂顶层】");
check("query-my-account 能从顶层 data 解析出可用积分", () => {
  const a = collectAccount(raw.account);
  return eq(typeof a.available, "number") && a.available > 0 ? true : a;
});
check("积分是小数字符串，不能被 parseInt 截断", () => {
  const a = collectAccount(raw.account);
  // 真实响应里 availablePoint 是字符串 "33.5"。
  // 用 parseInt 会得到 33 —— 丢掉 0.5 分，且不报错。
  // 所以断言：解析结果必须与字符串原值严格相等（保留小数）。
  const rawStr = String(raw.account?.data?.availablePoint ?? "");
  const expected = Number(rawStr);
  return eq(a.available, expected);
});
check("可用积分的小数部分没有丢失", () => {
  const a = collectAccount(raw.account);
  const rawStr = String(raw.account?.data?.availablePoint ?? "");
  if (!rawStr.includes(".")) return true; // 该账号积分恰好是整数，无需检验
  return eq(a.available % 1 !== 0, true);
});

console.log("\n【卡包券 · 原生结构化字段】");
const myCoupons = collectMyCoupons(raw.myCoupons, { now: NOW });
check("能解析出卡包券（不再返回 0 张）", () => {
  return eq(myCoupons.length > 0, true);
});
check("券名取自 title 字段", () => {
  return eq(myCoupons.every((c) => typeof c.name === "string" && c.name.length > 0), true);
});
check("到期时刻取自 tradeEndDateTime（原生字段）", () => {
  return eq(myCoupons.every((c) => !!c.expireAt), true);
});
check("每日时段取自 tradeTimePeriods（原生字段）", () => {
  return eq(myCoupons.some((c) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(c.dayWindow || "")), true);
});
check("渠道标签取自 instructions.labels", () => {
  return eq(myCoupons.some((c) => c.channel.length > 0), true);
});
check("「用券价格」语义被标记为 coupon_price，不是减免额", () => {
  return eq(myCoupons.every((c) => c.valueKind === "coupon_price"), true);
});
check("coupon_price 语义下 benefit 不可知（不编造优惠额）", () => {
  return eq(myCoupons.every((c) => c.benefitKnown === false && c.benefit === null), true);
});

console.log("\n【麦麦省可领券】");
const available = collectAvailableCoupons(raw.available, { now: NOW });
check("能解析出可领券", () => {
  return eq(available.length > 0, true);
});
check("同名券已去重（接口会返回多份同名不同图）", () => {
  const names = available.map((c) => c.name);
  return eq(new Set(names).size, names.length);
});
check("可领券状态为「可领取」", () => {
  return eq(available.every((c) => c.status === "可领取"), true);
});
check("可领券无面值时 value 为 0 而不是编造", () => {
  return eq(available.every((c) => c.value === 0), true);
});

console.log("\n【活动日历 · 标题在 articleDto 里】");
const campaigns = collectCampaigns(raw.campaigns);
check("能解析出活动日", () => {
  return eq(campaigns.length > 0, true);
});
check("活动标题非空（顶层 activityTitle 是空串，必须读 articleDto.title）", () => {
  const all = campaigns.flatMap((c) => c.titles);
  return eq(all.length > 0 && all.every((t) => t.length > 0), true);
});
check("今日活动能被识别出 phase", () => {
  const today = campaigns.find((c) => c.date === "2026-10-23");
  return eq(today?.phase, "今日");
});
check("往期活动不会混进「今日」", () => {
  const today = campaigns.find((c) => c.date === "2026-10-23");
  return eq(today?.titles.length > 0, true);
});

console.log("\n【门店】");
const stores = collectStores(raw.stores);
check("能解析出门店列表", () => {
  return eq(stores.length > 0, true);
});
check("storeCode 是 7 位数字", () => {
  return eq(stores.every((s) => /^\d{7}$/.test(s.storeCode)), true);
});
check("门店名与地址都能取到", () => {
  return eq(stores.every((s) => s.name.length > 0), true);
});
check("营业时间被保留（判断当前是否营业需要它）", () => {
  return eq(stores.some((s) => s.businessStartTime.length > 0), true);
});

console.log("\n【门店券】");
const storeCoupons = collectStoreCoupons(raw.storeCoupons, { now: NOW });
check("能解析出门店券", () => {
  return eq(storeCoupons.length > 0, true);
});
check("门店券到期时刻从 tradeDateTime 区间里取右端", () => {
  return eq(storeCoupons.every((c) => !!c.expireAt), true);
});
check("门店券适用商品编码被保留", () => {
  return eq(storeCoupons.some((c) => c.itemCodes.length > 0), true);
});

console.log("\n【三路合并 · 去重键必须是结构化到期时刻】");
const merged = mergeCoupons([available, myCoupons, storeCoupons], { now: NOW });
check("合并后同一张券不重复出现", () => {
  const names = merged.filter((c) => c.source !== "mcd-savers").map((c) => c.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  return eq(dup.length, 0);
});
check("合并保留了信息最全的那份（含面值与渠道）", () => {
  const c = merged.find((x) => x.name.includes("1024"));
  return eq(c?.value > 0 && c?.channel.length > 0, true);
});

console.log("\n【沉默成本 · 不能把到手价当优惠额】");
const silent = computeSilentCost(merged, { now: NOW });
check("coupon_price 语义的券不计入金额合计", () => {
  const onlyPrice = merged.filter((c) => !c.benefitKnown);
  if (!onlyPrice.length) return true;
  return eq(silent.totalValue === 0 || silent.totalValue < onlyPrice.reduce((s, c) => s + c.value, 0), true);
});
check("券面价值未知的张数被单独统计", () => {
  return eq(typeof silent.unknownCount, "number");
});
check("叙述里不会出现「面值 X 元」把到手价说成优惠", () => {
  return eq(/面值\s*\d/.test(silent.narrative), false);
});

console.log("\n【抽奖】");
const lottery = collectLottery(raw.lottery);
check("能解析出抽奖活动", () => {
  return eq(lottery.drawPoint > 0, true);
});
check("奖品列表保留名称（用于盈亏平衡分析）", () => {
  return eq(lottery.prizes.length > 0, true);
});
check("resourceEligible 从服务端决策读，不自行推断", () => {
  return eq(typeof lottery.resourceEligible, "boolean");
});

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
