#!/usr/bin/env node
/**
 * mcd-points-strategist · 每日巡检
 *
 * 一次跑完「今天该薅的羊毛」，并与上一次快照对比找出变化。
 *
 * 巡检项（借鉴 maimen-butler 的骨架，单项失败不拖垮全局）：
 *   1. now-time-info      时间锚点
 *   2. query-my-account   积分余额与临期
 *   3. available-coupons  可领券
 *   4. query-my-coupons   卡包券
 *   5. campaign-calendar  今日活动
 *   6. query-lottery-info 抽奖机会
 *   7. mall-points-products 商城在售标的
 *   8. order-list         历史订单（用于识别你在手机上下了一单）
 *
 * 用法：
 *   MCD_MCP_TOKEN=xxx node scripts/app/patrol.mjs
 *   MCD_MCP_TOKEN=xxx node scripts/app/patrol.mjs --json
 *   MCD_MCP_TOKEN=xxx node scripts/app/patrol.mjs --no-claim   # 不领券，只看
 *
 * 写操作（领券）默认**不执行** —— 需显式 --claim。
 */

import { writeFile, mkdir, readFile, rename } from "node:fs/promises";
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
import { normalizeSnapshot } from "../collect/normalize.mjs";
import { diffSnapshots } from "../analyze/diff.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA = resolve(ROOT, "data");
const CURRENT = resolve(DATA, "snapshot.json");
const PREVIOUS = resolve(DATA, "snapshot.prev.json");
const PROFILE = resolve(DATA, "profile.json");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const wantJson = has("json");
const allowClaim = has("claim");

/** 单项巡检容错：失败不拖垮整份报告。 */
async function probe(errors, name, fn) {
  try {
    return await fn();
  } catch (e) {
    errors.push({ tool: name, error: String(e?.message || e).slice(0, 200) });
    return null;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function resolveStore() {
  const explicit = arg("store", null);
  if (explicit) return explicit;
  const p = await readJson(PROFILE);
  return p?.favouriteStore?.storeCode || null;
}

async function main() {
  const client = new McpClient();
  await client.initialize();
  console.error("MCP 握手完成，开始巡检…");

  const errors = [];

  // ---- 领券（写操作，需显式开启）----
  let claimed = null;
  if (allowClaim) {
    claimed = await probe(errors, "auto-bind-coupons", async () => {
      const res = await client.callTool("auto-bind-coupons", {}, { allowWrite: true });
      return { ok: true, result: res };
    });
  }

  // ---- 采集 ----
  const [account, mall, lottery, campaigns, available, myCoupons, orders, stores] =
    await Promise.all([
      probe(errors, "query-my-account", async () => collectAccount(await client.callTool("query-my-account"))),
      probe(errors, "mall-points-products", async () => collectMall(await client.callTool("mall-points-products"))),
      probe(errors, "query-lottery-info", async () => collectLottery(await client.callTool("query-lottery-info"))),
      probe(errors, "campaign-calendar", async () => {
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

  // ---- 门店相关 ----
  const store = await resolveStore();
  let storeCoupons = null;
  let promotions = null;
  if (store) {
    storeCoupons = await probe(errors, "query-store-coupons", async () =>
      collectStoreCoupons(
        rawText(await client.callTool("query-store-coupons", { orderType: 1, beType: 1, storeCode: store }))
      )
    );
    promotions = await probe(errors, "query-promotions", async () => {
      const res = await client.callTool("query-promotions", { storeCode: store, orderType: 1, beType: 1 });
      const parsed = collectPromotions(res);
      return parsed.length ? parsed : collectPromotionsMarkdown(rawText(res));
    });
  }

  const coupons = mergeCoupons([available, myCoupons, storeCoupons]);
  const snapshot = normalizeSnapshot(
    assembleSnapshot({
      account,
      mall,
      coupons,
      campaigns,
      lottery,
      orders,
      stores,
      promotions,
      errors,
    })
  );

  // ---- 与上一次对比 ----
  const prev = await readJson(CURRENT);
  const diff = diffSnapshots(prev ? normalizeSnapshot(prev) : null, snapshot);

  // ---- 落盘：当前 → 上一次 → 覆盖当前 ----
  await mkdir(DATA, { recursive: true });
  if (prev) {
    await writeFile(PREVIOUS, `${JSON.stringify(prev, null, 2)}\n`, "utf8");
  }
  await writeFile(CURRENT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  const result = { snapshot, diff, claimed: !!claimed, store, errors };

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { renderPatrol } = await import("./render.mjs");
  console.log(renderPatrol(result));
}

main().catch((e) => {
  console.error("巡检失败：", e.message);
  process.exit(1);
});
