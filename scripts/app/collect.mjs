#!/usr/bin/env node
/**
 * mcd-points-strategist · 资产采集
 *
 * 拉取麦当劳 MCP 的积分、券、活动、抽奖、订单、门店数据，
 * 组装成统一快照并落盘。
 *
 * 用法：
 *   MCD_MCP_TOKEN=xxx node scripts/app/collect.mjs
 *   MCD_MCP_TOKEN=xxx node scripts/app/collect.mjs --out data/snapshot.json
 *   MCD_MCP_TOKEN=xxx node scripts/app/collect.mjs --store 1990622   # 附带门店券与促销
 *
 * 关键设计：
 *   - 单项失败不拖垮全局（每项独立 try，错误记入 snapshot.errors）
 *   - 券分三路拉取后合并：mcd-savers（账户全域）/ my（卡包）/ store（门店）
 *   - 金额单位「分 → 元」的转换只发生在 collect 层
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpClient, rawText } from "../lib/mcp-client.mjs";
import {
  assembleSnapshot,
  collectAccount,
  collectAvailableCoupons,
  collectCampaigns,
  collectLottery,
  collectMall,
  collectMyCoupons,
  collectOrders,
  collectPromotions,
  collectPromotionsMarkdown,
  collectStoreCoupons,
  collectStores,
  mergeCoupons,
} from "../collect/collectors.mjs";
import { validateSnapshotDeep } from "../lib/schema.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PROFILE = resolve(ROOT, "data/profile.json");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(ROOT, arg("out", "data/snapshot.json"));

/**
 * 门店来源优先级：
 *   ① --store 参数显式指定
 *   ② data/profile.json 里存的常用门店
 *   ③ 都不�� → 不拉门店相关数据（领券与门店无关，仍可正常采集）
 */
async function resolveStore() {
  const explicit = arg("store", null);
  if (explicit) return { storeCode: explicit, from: "参数" };
  try {
    const p = JSON.parse(await readFile(PROFILE, "utf8"));
    if (p?.favouriteStore?.storeCode) {
      return { storeCode: p.favouriteStore.storeCode, from: "常用门店" };
    }
  } catch {
    /* 没有档案则继续 */
  }
  return { storeCode: null, from: null };
}

/** 单项采集的统一包装：失败不抛出，错误记入 errors。 */
async function probe(errors, name, fn) {
  try {
    return await fn();
  } catch (e) {
    errors.push({ tool: name, error: String(e?.message || e).slice(0, 200) });
    return null;
  }
}

async function main() {
  const client = new McpClient();
  await client.initialize();
  console.log("MCP 握手完成，开始采集…");

  const errors = [];

  // ---- 无需门店上下文的数据 ----
  const [account, mall, lottery, prizes, campaigns, available, myCoupons, orders, stores] =
    await Promise.all([
      probe(errors, "query-my-account", async () => collectAccount(await client.callTool("query-my-account"))),
      probe(errors, "mall-points-products", async () => collectMall(await client.callTool("mall-points-products"))),
      probe(errors, "query-lottery-info", async () => collectLottery(await client.callTool("query-lottery-info"))),
      probe(errors, "query-my-prizes", async () => await client.callTool("query-my-prizes")),
      probe(errors, "campaign-calendar", async () => {
        // campaign-calendar 必传 specifiedDate，用服务器时间兜底本地日期
        const time = await client.callTool("now-time-info");
        const t = time?.data?.date || time?.data?.formatted || null;
        const res = await client.callTool("campaign-calendar", t ? { specifiedDate: t } : {});
        return collectCampaigns(rawText(res));
      }),
      probe(errors, "available-coupons", async () =>
        collectAvailableCoupons(rawText(await client.callTool("available-coupons")))
      ),
      probe(errors, "query-my-coupons", async () =>
        collectMyCoupons(rawText(await client.callTool("query-my-coupons")))
      ),
      probe(errors, "order-list", async () => collectOrders(await client.callTool("order-list"))),
      probe(errors, "query-nearby-stores", async () =>
        collectStores(rawText(await client.callTool("query-nearby-stores", { beType: 1, searchType: 1 })))
      ),
    ]);

  // ---- 门店相关数据（需要 storeCode）----
  const store = await resolveStore();
  let storeCoupons = null;
  let promotions = null;
  if (store.storeCode) {
    storeCoupons = await probe(errors, "query-store-coupons", async () =>
      collectStoreCoupons(
        rawText(
          await client.callTool("query-store-coupons", {
            orderType: 1,
            beType: 1,
            storeCode: store.storeCode,
          })
        )
      )
    );
    promotions = await probe(errors, "query-promotions", async () => {
      const res = await client.callTool("query-promotions", {
        storeCode: store.storeCode,
        orderType: 1,
        beType: 1,
      });
      const parsed = collectPromotions(res);
      return parsed.length ? parsed : collectPromotionsMarkdown(rawText(res));
    });
  }

  const coupons = mergeCoupons([available, myCoupons, storeCoupons]);
  const snapshot = assembleSnapshot({
    account,
    mall,
    coupons,
    campaigns,
    lottery,
    orders,
    stores,
    promotions,
    errors,
  });

  // 契约校验：坏数据在这里就被挡住，不流向下游
  const problems = validateSnapshotDeep(snapshot);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`\n✓ 已写入 ${OUT.replace(ROOT + "/", "")}`);
  console.log(`  积分      ${snapshot.account ? `${snapshot.account.available} 可用 / ${snapshot.account.accumulative} 累计` : "—"}`);
  console.log(`  商城标的  ${snapshot.mall.length} 件（其中在售 ${snapshot.mall.filter((m) => m.status === "live").length}）`);
  console.log(`  券        ${snapshot.coupons.length} 张（麦麦省 ${available?.length ?? 0} / 卡包 ${myCoupons?.length ?? 0} / 门店 ${storeCoupons?.length ?? 0}）`);
  console.log(`  活动      ${snapshot.campaigns.length} 天`);
  console.log(`  订单      ${snapshot.orders.length} 条`);
  console.log(`  门店      ${snapshot.stores.length} 家${store.storeCode ? ` · 核对门店 ${store.storeCode}（${store.from}）` : " · 未设常用门店，门店券与促销未采集"}`);
  if (promotions) console.log(`  门店促销  ${promotions.length} 条`);
  if (snapshot.errors.length) {
    console.log(`\n⚠ ${snapshot.errors.length} 项采集失败：`);
    for (const e of snapshot.errors) console.log(`   · ${e.tool}: ${e.error}`);
  }
  if (problems.length) {
    console.log(`\n⚠ 契约校验发现 ${problems.length} 处问题：`);
    for (const p of problems.slice(0, 10)) console.log(`   · ${p}`);
  }
  if (prizes === null) console.log("  （奖品记录未取到）");
}

main().catch((e) => {
  console.error("采集失败：", e.message);
  process.exit(1);
});
