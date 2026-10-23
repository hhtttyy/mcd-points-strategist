#!/usr/bin/env node
/**
 * mcd-points-strategist · 券实际价值测算
 *
 * 卡包券的 `discountDesc` 是「用券价格」（你付的钱），不是「省的钱」。
 * 所以「这张券值多少」必须拿**原价对比**才能算 ——
 * 而唯一可靠的对比基准是 `calculate-price` 跑两次。
 *
 * 用法：
 *   MCD_MCP_TOKEN=<token> node scripts/app/measure-coupons.mjs
 *   MCD_MCP_TOKEN=<token> node scripts/app/measure-coupons.mjs --store 1950979
 *   MCD_MCP_TOKEN=<token> node scripts/app/measure-coupons.mjs --json
 *
 * ⚠️ 只读：calculate-price 只算价不创建订单，绝不调用 create-order。
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpClient } from "../lib/mcp-client.mjs";
import { normalizeSnapshot } from "../collect/normalize.mjs";
import { summarizeCouponValues } from "../analyze/coupon-value.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SNAPSHOT = resolve(ROOT, arg("snapshot", "data/snapshot.json"));
const wantJson = process.argv.includes("--json");

/**
 * 找到券里能定位到商品的编码。
 *
 * 门店券的 `itemCodes` 来自 `products[].productCode`；
 * 卡包券没有这个字段（接口不返回），所以只能靠门店券补齐。
 */
function couponItemCodes(coupon) {
  return Array.isArray(coupon.itemCodes) ? coupon.itemCodes.filter(Boolean) : [];
}

async function main() {
  let raw;
  try {
    raw = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  } catch {
    console.error(`读不到快照：${SNAPSHOT.replace(ROOT + "/", "")}`);
    process.exit(1);
  }
  const snap = normalizeSnapshot(raw);

  const storeCode = arg("store", snap.storeCode || null);
  if (!storeCode) {
    console.error("缺少 storeCode —— 用 --store 指定，或先跑一次 collect.mjs（会自动带上常用门店）");
    process.exit(1);
  }

  // 需要测算的券：
  //   ① 在卡包里（sources 含 "my"）—— 只有卡包券有「用券价格」语义与券码
  //   ② 价值语义是 coupon_price —— 减免额语义的券不需要测算
  //   ③ 有适用商品编码 —— 否则无法定位到菜品去算原价
  //
  // ⚠️ 合并后 `source` 可能是 "store"（门店源优先），但 `sources` 数组
  //    记录了「这张券在哪些视角下可见」—— 判断要用 sources，不能用 source。
  const targets = (snap.coupons || []).filter(
    (c) =>
      (c.sources || [c.source]).includes("my") &&
      c.valueKind === "coupon_price" &&
      couponItemCodes(c).length
  );

  if (!targets.length) {
    console.log("没有需要测算的券（需要：卡包持有 + 用券价格语义 + 有适用商品编码）");
    if (wantJson) console.log(JSON.stringify({ items: [], totalSaving: 0 }, null, 2));
    return;
  }

  const client = new McpClient();
  await client.initialize();

  const pricing = {};
  for (const c of targets) {
    const code = couponItemCodes(c)[0];
    process.stdout.write(`  测算「${c.name}」(${code})… `);
    try {
      const without = await client.callTool("calculate-price", {
        storeCode,
        orderType: 1,
        beType: 1,
        items: [{ productCode: code, quantity: 1 }],
      });
      const withC = await client.callTool("calculate-price", {
        storeCode,
        orderType: 1,
        beType: 1,
        items: [
          {
            productCode: code,
            quantity: 1,
            couponId: c.id || undefined,
            couponCode: c.code || undefined,
          },
        ],
      });
      pricing[c.id] = { without, with: withC };
      console.log("完成");
    } catch (e) {
      console.log(`失败：${String(e?.message || e).slice(0, 60)}`);
    }
  }

  const summary = summarizeCouponValues(snap.coupons, pricing);

  if (wantJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("\n┌──────────────────────────────────────────────┐");
  console.log("│        💰 券实际价值测算                      │");
  console.log("└──────────────────────────────────────────────┘");
  console.log(`门店：${storeCode}\n`);

  for (const item of summary.items) {
    if (item.known) {
      console.log(`  ✅ ${item.name}`);
      console.log(
        `     原价 ¥${item.originalYuan} → 用券 ¥${item.payableYuan}  ·  实省 ¥${item.saving}` +
          (item.rate ? `（${(item.rate * 100).toFixed(1)}% off）` : "")
      );
    } else if (item.valueKind === "coupon_price") {
      console.log(`  ⚠️  ${item.name}  券面 ¥${item.faceValue}（用券价格）`);
      console.log(`     ${item.reason}`);
    }
  }

  if (summary.knownCount) {
    console.log(`\n合计可省 ¥${summary.totalSaving}`);
    if (summary.best) {
      console.log(`最值钱的：${summary.best.name}（省 ¥${summary.best.saving}）`);
    }
  }
  if (summary.unknownCount) {
    console.log(`另有 ${summary.unknownCount} 张未能测算（券面标的是用券价格，需原价对比才能确定）`);
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
