#!/usr/bin/env node
/**
 * mcd-points-strategist · 门店档案
 *
 * 门店的作用只有一个：**拿到 storeCode**，因为四类数据都绑门店：
 *   query-store-coupons  门店专属券
 *   query-promotions     门店级促销（未在官方文档中）
 *   query-meals          门店菜单与价格
 *   calculate-price      计价
 *
 * 而 `available-coupons`（麦麦省可领券）是**账户全域**的 —— 领券不需要门店。
 * 所以正确顺序是：**先领券，再定位门店核对细节**。
 *
 * 用法：
 *   node scripts/app/stores.mjs list                    # 列出附近门店
 *   node scripts/app/stores.mjs pick 1990622            # 把某店存为常用门店
 *   node scripts/app/stores.mjs current                 # 查看当前常用门店
 *   node scripts/app/stores.mjs clear                   # 清除常用门店
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpClient, rawText } from "../lib/mcp-client.mjs";
import { collectStores } from "../collect/collectors.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PROFILE = resolve(ROOT, "data/profile.json");

/** 门店档案是个人偏好（含常去门店），属于个人数据，不进版本库。 */
async function loadProfile() {
  try {
    return JSON.parse(await readFile(PROFILE, "utf8"));
  } catch {
    return { favouriteStore: null, seenStores: [] };
  }
}

async function saveProfile(p) {
  await mkdir(dirname(PROFILE), { recursive: true });
  await writeFile(PROFILE, `${JSON.stringify(p, null, 2)}\n`, "utf8");
}

async function listStores() {
  const client = new McpClient();
  await client.initialize();
  const raw = rawText(
    await client.callTool("query-nearby-stores", { beType: 1, searchType: 1 })
  );
  const stores = collectStores(raw);
  if (!stores.length) {
    console.log("未解析到门店。原始响应前 400 字：\n" + raw.slice(0, 400));
    return;
  }
  console.log(`附近门店 ${stores.length} 家：\n`);
  for (const s of stores) {
    console.log(`  ${s.storeCode}  ${s.name || "(名称未解析)"}`);
  }
  console.log("\n用 `node scripts/app/stores.mjs pick <storeCode>` 存为常用门店。");
}

async function pickStore(code) {
  const client = new McpClient();
  await client.initialize();
  const raw = rawText(
    await client.callTool("query-nearby-stores", { beType: 1, searchType: 1 })
  );
  const stores = collectStores(raw);
  const found = stores.find((s) => s.storeCode === code);
  const profile = await loadProfile();
  profile.favouriteStore = {
    storeCode: code,
    name: found?.name || "",
    pickedAt: new Date().toISOString(),
  };
  profile.seenStores = [...new Set([...(profile.seenStores || []), code])].slice(-20);
  await saveProfile(profile);
  console.log(`✓ 已存为常用门店：${code} ${found?.name || ""}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list") return listStores();
  if (cmd === "pick") {
    if (!arg) {
      console.error("用法：stores.mjs pick <storeCode>");
      process.exit(1);
    }
    return pickStore(arg);
  }
  if (cmd === "current") {
    const p = await loadProfile();
    if (!p.favouriteStore) {
      console.log("尚未设置常用门店。用 `node scripts/app/stores.mjs pick <storeCode>` 设置。");
    } else {
      console.log(`常用门店：${p.favouriteStore.storeCode}  ${p.favouriteStore.name}`);
    }
    return;
  }
  if (cmd === "clear") {
    const p = await loadProfile();
    p.favouriteStore = null;
    await saveProfile(p);
    console.log("✓ 已清除常用门店");
    return;
  }
  console.log("用法：stores.mjs list | pick <storeCode> | current | clear");
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
