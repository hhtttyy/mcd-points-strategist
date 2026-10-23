#!/usr/bin/env node
/**
 * mcd-points-strategist · GitHub Pages 构建
 *
 * GitHub Pages 只发布 /docs 目录，而 Demo 需要加载仓库根目录下的
 *   scripts/points-engine.mjs   （积分算法引擎）
 *   scripts/analyze/coupon-*.mjs  （券引擎）
 *   scripts/analyze/asset-plan.mjs（积分×券联合决策）
 *   scripts/collect/normalize.mjs （快照版本兼容层）
 *   fixtures/mcd-snapshot.json    （脱敏数据快照）
 * 直接引用 ../ 会 404，因此构建时复制到 docs/ 内部路径。
 *
 * 用法：node scripts/build-pages.mjs
 * 校验：node scripts/build-pages.mjs --check
 */

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** 需要复制到 docs/vendor/ 的模块（保持相对 import 关系不变）。 */
const MODULES = [
  ["scripts/points-engine.mjs", "docs/vendor/points-engine.mjs"],
  ["scripts/lib/schema.mjs", "docs/vendor/lib/schema.mjs"],
  ["scripts/collect/parse.mjs", "docs/vendor/collect/parse.mjs"],
  ["scripts/collect/normalize.mjs", "docs/vendor/collect/normalize.mjs"],
  ["scripts/analyze/coupon-model.mjs", "docs/vendor/analyze/coupon-model.mjs"],
  ["scripts/analyze/coupon-stack.mjs", "docs/vendor/analyze/coupon-stack.mjs"],
  ["scripts/analyze/coupon-audit.mjs", "docs/vendor/analyze/coupon-audit.mjs"],
  ["scripts/analyze/coupon-schedule.mjs", "docs/vendor/analyze/coupon-schedule.mjs"],
  ["scripts/analyze/asset-plan.mjs", "docs/vendor/analyze/asset-plan.mjs"],
];

const SRC_DATA = resolve(ROOT, "fixtures/mcd-snapshot.json");
const DST_DATA = resolve(ROOT, "docs/data/mcd-snapshot.json");
const INDEX = resolve(ROOT, "docs/index.html");

const checkOnly = process.argv.includes("--check");

/**
 * 复制模块时需要重写 import 路径：
 *   ../lib/schema.mjs      → ../lib/schema.mjs（结构一致，不变）
 *   ./coupon-model.mjs     → 不变（同目录）
 *   ../lib/schema.mjs      → 不变
 * 由于 docs/vendor/ 保持了 scripts/ 下的相对目录结构（lib/、collect/、analyze/），
 * import 路径无需任何改写 —— 这正是选择按目录复制而非平铺的原因。
 */
async function main() {
  if (!existsSync(SRC_DATA)) {
    console.error("源文件缺失，无法构建");
    process.exit(1);
  }

  if (checkOnly) {
    const ok = [];
    for (const [src, dst] of [...MODULES, ["fixtures/mcd-snapshot.json", "docs/data/mcd-snapshot.json"]]) {
      const s = resolve(ROOT, src);
      const d = resolve(ROOT, dst);
      if (!existsSync(d)) { ok.push(`缺失: ${dst}`); continue; }
      const a = await readFile(s, "utf8");
      const b = await readFile(d, "utf8");
      ok.push(a === b ? `✓ 同步: ${dst.replace(ROOT + "/", "")}` : `✗ 不同步: ${dst.replace(ROOT + "/", "")}`);
    }
    console.log(ok.join("\n"));
    process.exit(ok.some((l) => l.startsWith("✗") || l.startsWith("缺失")) ? 1 : 0);
  }

  for (const [src, dst] of MODULES) {
    const s = resolve(ROOT, src);
    if (!existsSync(s)) {
      console.error(`源文件缺失：${src}`);
      process.exit(1);
    }
    await mkdir(dirname(resolve(ROOT, dst)), { recursive: true });
    await copyFile(s, resolve(ROOT, dst));
  }

  await mkdir(dirname(DST_DATA), { recursive: true });
  await copyFile(SRC_DATA, DST_DATA);

  // 确保 index.html 引用的是 docs 内路径
  const html = await readFile(INDEX, "utf8");
  const fixed = html
    .replace(/from\s+"\.\.\/scripts\/points-engine\.mjs"/, 'from "./vendor/points-engine.mjs"')
    .replace(/from\s+"\.\.\/scripts\/analyze\/([\w-]+)\.mjs"/g, 'from "./vendor/analyze/$1.mjs"')
    .replace(/from\s+"\.\.\/scripts\/collect\/([\w-]+)\.mjs"/g, 'from "./vendor/collect/$1.mjs"')
    .replace(/fetch\("\.\.\/fixtures\/mcd-snapshot\.json"\)/, 'fetch("./data/mcd-snapshot.json")');
  if (fixed !== html) {
    await writeFile(INDEX, fixed, "utf8");
    console.log("✓ 已修正 index.html 的引用路径");
  }

  console.log(`✓ 已复制 ${MODULES.length} 个模块 → docs/vendor/`);
  for (const [src, dst] of MODULES) {
    console.log(`  ${src}  →  ${dst}`);
  }
  console.log("✓ 已复制 fixtures/mcd-snapshot.json → docs/data/mcd-snapshot.json");
  console.log("构建完成。GitHub Pages 将从 /docs 目录发布。");
}

main().catch((e) => {
  console.error("构建失败:", e.message);
  process.exit(1);
});
