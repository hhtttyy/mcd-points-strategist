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
  const channel = CHANNEL;
  const hour = HOUR !== null ? Number(HOUR) : now.getHours();

  if (wantJson) {
    console.log(JSON.stringify({ snapshot, diff }, null, 2));
    return;
  }

  if (process.argv.includes("--full")) {
    console.log(renderPatrol({ snapshot, diff }));
    return;
  }

  console.log(
    renderDashboard(
      { snapshot, diff, channel, hour, prevAccount: prev?.account ?? null },
      { now, channel, hour }
    )
  );
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
