#!/usr/bin/env node
/**
 * mcd-points-strategist · 看板输出
 *
 * 读快照 → 渲染对话内看板。
 * 与 `patrol.mjs` 分开：patrol 负责采集（网络），本脚本只负责呈现（无网络）。
 *
 * 用法：
 *   node scripts/app/dashboard.mjs                        # 看板
 *   node scripts/app/dashboard.mjs --channel pickup       # 按到店场景判定券可用性
 *   node scripts/app/dashboard.mjs --hour 18              # 按当前小时判定时段
 *   node scripts/app/dashboard.mjs --snapshot <path>      # 指定快照
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeSnapshot } from "../collect/normalize.mjs";
import { diffSnapshots } from "../analyze/diff.mjs";
import { renderDashboard, renderPatrol } from "./render.mjs";
import { McpClient } from "../lib/mcp-client.mjs";
import { summarizeCouponValues } from "../analyze/coupon-value.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SNAPSHOT = resolve(ROOT, arg("snapshot", "data/snapshot.json"));
const PREV = resolve(ROOT, arg("prev", "data/snapshot.prev.json"));
const CHANNEL = arg("channel", null);
const HOUR = arg("hour", null);
const wantJson = process.argv.includes("--json");

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const raw = await readJson(SNAPSHOT);
  if (!raw) {
    console.error(
      `读不到快照：${SNAPSHOT.replace(ROOT + "/", "")}\n` +
        `先跑一次巡检：MCD_MCP_TOKEN=<你的Token> node scripts/app/patrol.mjs`
    );
    process.exit(1);
  }

  const snapshot = normalizeSnapshot(raw);
  const prevRaw = await readJson(PREV);
  const prev = prevRaw ? normalizeSnapshot(prevRaw) : null;

  const now = new Date();
  const diff = diffSnapshots(prev, snapshot, { now });

  // 最近一次领券时刻 —— 用来诊断「App 里看不到刚领的券」
  let claimAt = null;
  try {
    const lc = JSON.parse(await readFile(resolve(ROOT, "data/last-claim.json"), "utf8"));
    claimAt = lc.claimAt || null;
  } catch {
    /* 没有记录则跳过 */
  }
  const channel = CHANNEL;
  const hour = HOUR !== null ? Number(HOUR) : now.getHours();

  // 券的实际优惠额测算（需要网络 + MCP）
  // ⚠️ 默认开启：这是「券到底省多少」的唯一可靠答案。
  //    没测算过的话，看板只能说「到手价 ¥20.48」而说不出「实省 ¥13.52」。
  let couponValues = null;
  if (!process.argv.includes("--no-measure")) {
    couponValues = await measureCoupons(snapshot, arg("store", null));
  }

  if (wantJson) {
    console.log(JSON.stringify({ snapshot, diff, couponValues }, null, 2));
    return;
  }

  if (process.argv.includes("--full")) {
    console.log(renderPatrol({ snapshot, diff }));
    return;
  }

  console.log(
    renderDashboard(
      {
        snapshot,
        diff,
        channel,
        hour,
        prevAccount: prev?.account ?? null,
        // 门店标识：用于在「门店优惠」区块显示门店名
        storeCode: arg("store", null),
        couponValues,
        claimAt,
      },
      { now, channel, hour }
    )
  );
}

/**
 * 用 calculate-price 测算券的实际优惠额。
 *
 * ⚠️ 只读接口，不创建订单。失败不阻塞看板 —— 拿不到就退回「到手价」表述。
 */
async function measureCoupons(snapshot, storeCode) {
  const store = storeCode || snapshot?.storeCode;
  if (!store) return null;
  // 只测「卡包持有 + 用券价格语义 + 有适用商品编码」的券
  const targets = (snapshot.coupons || []).filter(
    (c) =>
      (c.sources || [c.source]).includes("my") &&
      c.valueKind === "coupon_price" &&
      Array.isArray(c.itemCodes) &&
      c.itemCodes.length
  );
  if (!targets.length) return null;

  const client = new McpClient();
  try {
    await client.initialize();
    const pricing = {};
    for (const c of targets) {
      const code = c.itemCodes[0];
      try {
        const without = await client.callTool("calculate-price", {
          storeCode: store,
          orderType: 1,
          beType: 1,
          items: [{ productCode: code, quantity: 1 }],
        });
        const withC = await client.callTool("calculate-price", {
          storeCode: store,
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
      } catch {
        /* 单张券测算失败不影响其他 */
      }
    }
    return summarizeCouponValues(snapshot.coupons, pricing);
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
