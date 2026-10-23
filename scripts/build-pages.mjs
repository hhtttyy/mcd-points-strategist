#!/usr/bin/env node
/**
 * mcd-points-strategist · GitHub Pages 构建
 *
 * GitHub Pages 只发布 /docs 目录，而 Demo 需要加载仓库根目录下的
 *   scripts/points-engine.mjs   （算法引擎）
 *   fixtures/mcd-snapshot.json  （脱敏数据快照）
 * 直接引用 ../ 会 404，因此构建时复制到 docs/ 内部路径。
 *
 * 用法：node scripts/build-pages.mjs
 * 校验：node scripts/build-pages.mjs --check
 */

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SRC_ENGINE = resolve(ROOT, "scripts/points-engine.mjs");
const SRC_DATA = resolve(ROOT, "fixtures/mcd-snapshot.json");
const DST_ENGINE = resolve(ROOT, "docs/vendor/points-engine.mjs");
const DST_DATA = resolve(ROOT, "docs/data/mcd-snapshot.json");
const INDEX = resolve(ROOT, "docs/index.html");

const checkOnly = process.argv.includes("--check");

async function main() {
  if (!existsSync(SRC_ENGINE) || !existsSync(SRC_DATA)) {
    console.error("源文件缺失，无法构建");
    process.exit(1);
  }

  if (checkOnly) {
    const ok = [];
    for (const [src, dst] of [[SRC_ENGINE, DST_ENGINE], [SRC_DATA, DST_DATA]]) {
      if (!existsSync(dst)) { ok.push(`缺失: ${dst}`); continue; }
      const a = await readFile(src, "utf8");
      const b = await readFile(dst, "utf8");
      ok.push(a === b ? `✓ 同步: ${dst.replace(ROOT + "/", "")}` : `✗ 不同步: ${dst.replace(ROOT + "/", "")}`);
    }
    console.log(ok.join("\n"));
    process.exit(ok.some((l) => l.startsWith("✗") || l.startsWith("缺失")) ? 1 : 0);
  }

  await mkdir(dirname(DST_ENGINE), { recursive: true });
  await mkdir(dirname(DST_DATA), { recursive: true });
  await copyFile(SRC_ENGINE, DST_ENGINE);
  await copyFile(SRC_DATA, DST_DATA);

  // 确保 index.html 引用的是 docs 内路径
  const html = await readFile(INDEX, "utf8");
  const fixed = html
    .replace(/from\s+"\.\.\/scripts\/points-engine\.mjs"/, 'from "./vendor/points-engine.mjs"')
    .replace(/fetch\("\.\.\/fixtures\/mcd-snapshot\.json"\)/, 'fetch("./data/mcd-snapshot.json")');
  if (fixed !== html) {
    await writeFile(INDEX, fixed, "utf8");
    console.log("✓ 已修正 index.html 的引用路径");
  }

  console.log("✓ 已复制 scripts/points-engine.mjs  → docs/vendor/points-engine.mjs");
  console.log("✓ 已复制 fixtures/mcd-snapshot.json → docs/data/mcd-snapshot.json");
  console.log("构建完成。GitHub Pages 将从 /docs 目录发布。");
}

main().catch((e) => {
  console.error("构建失败:", e.message);
  process.exit(1);
});
