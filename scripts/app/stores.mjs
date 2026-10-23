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
 * ⚠️ 实测（2026-10-23）：
 *   `query-nearby-stores` 的 `searchType` 有两种：
 *     1 = 收藏餐厅（默认）。**没有收藏记录时返回 success:false / code:600050，
 *         data 字段直接缺失** —— 这是正常空态，不是错误。
 *     2 = 按位置搜索，**必传 city + keyword**。
 *   所以本脚本先试收藏，为空则自动降级为位置搜索（可用 --city / --keyword 指定）。
 *
 * 用法：
 *   node scripts/app/stores.mjs list                          # 收藏门店，无收藏则降级搜索
 *   node scripts/app/stores.mjs list --city 北京 --keyword 六道口   # 按位置搜
 *   node scripts/app/stores.mjs pick <storeCode>              # 存为常用门店
 *   node scripts/app/stores.mjs current                       # 查看当前常用门店
 *   node scripts/app/stores.mjs clear                         # 清除常用门店
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { McpClient } from "../lib/mcp-client.mjs";
import { collectStores } from "../collect/collectors.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const PROFILE = resolve(ROOT, "data/profile.json");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

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

/**
 * 拉取门店列表。
 *
 * 先试收藏（searchType=1），收藏为空则降级为位置搜索（searchType=2）。
 * 返回 { stores, source, notice } —— notice 说明降级原因，便于用户理解为什么搜到的不是收藏。
 */
async function fetchStores(client, { city, keyword } = {}) {
  // ① 收藏门店
  const fav = await client.callTool("query-nearby-stores", { beType: 1, searchType: 1 });
  const favStores = collectStores(fav);
  if (favStores.length) {
    return { stores: favStores, source: "收藏餐厅", notice: "" };
  }

  // ② 收藏为空 → 位置搜索
  if (!city || !keyword) {
    return {
      stores: [],
      source: "收藏餐厅",
      notice:
        "你还没有收藏任何餐厅，已自动切换为按位置搜索。\n" +
        "用 `--city 北京 --keyword 六道口` 指定位置，或先在 App 里收藏一家店。",
    };
  }
  const searched = await client.callTool("query-nearby-stores", {
    beType: 1,
    searchType: 2,
    city,
    keyword,
  });
  return {
    stores: collectStores(searched),
    source: `位置搜索「${city} · ${keyword}」`,
    notice: "收藏餐厅为空，已按位置搜索。",
  };
}

async function listStores() {
  const client = new McpClient();
  await client.initialize();
  const { stores, source, notice } = await fetchStores(client, {
    city: arg("city"),
    keyword: arg("keyword"),
  });

  if (notice) console.log(`ℹ ${notice}\n`);
  if (!stores.length) {
    console.log("未查到门店。");
    return;
  }
  console.log(`门店 ${stores.length} 家（来源：${source}）：\n`);
  for (const s of stores) {
    const dist = s.distance != null ? `  ${s.distance}m` : "";
    const hours = s.businessStartTime ? `  ${s.businessStartTime}-${s.businessEndTime}` : "";
    const open = s.businessStatus === false ? "  ⚠暂停营业" : "";
    console.log(`  ${s.storeCode}  ${s.name}${dist}${hours}${open}`);
    if (s.address) console.log(`      ${s.address}`);
  }
  console.log("\n用 `node scripts/app/stores.mjs pick <storeCode>` 存为常用门店。");
}

async function pickStore(code) {
  const client = new McpClient();
  await client.initialize();
  const { stores } = await fetchStores(client, { city: arg("city"), keyword: arg("keyword") });
  const found = stores.find((s) => s.storeCode === code);
  const profile = await loadProfile();
  profile.favouriteStore = {
    storeCode: code,
    name: found?.name || "",
    address: found?.address || "",
    pickedAt: new Date().toISOString(),
  };
  profile.seenStores = [...new Set([...(profile.seenStores || []), code])].slice(-20);
  await saveProfile(profile);
  console.log(`✓ 已存为常用门店：${code} ${found?.name || ""}`);
  if (!found) console.log("  （该店不在当前查询结果里，名称未记录）");
}

async function main() {
  const [cmd, positional] = process.argv.slice(2);
  if (cmd === "list") return listStores();
  if (cmd === "pick") {
    const code = positional || arg("store");
    if (!code) {
      console.error("用法：stores.mjs pick <storeCode>");
      process.exit(1);
    }
    return pickStore(code);
  }
  if (cmd === "current") {
    const p = await loadProfile();
    if (!p.favouriteStore) {
      console.log("尚未设置常用门店。用 `node scripts/app/stores.mjs pick <storeCode>` 设置。");
    } else {
      console.log(`常用门店：${p.favouriteStore.storeCode}  ${p.favouriteStore.name}`);
      if (p.favouriteStore.address) console.log(`  地址：${p.favouriteStore.address}`);
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
  console.log("用法：stores.mjs list [--city X --keyword Y] | pick <storeCode> | current | clear");
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
