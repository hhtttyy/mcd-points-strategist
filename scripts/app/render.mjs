/**
 * mcd-points-strategist · 看板渲染
 *
 * 把巡检结果渲染成**对话内**的结构化卡片。
 *
 * 设计约束（针对手机阅读）：
 *   1. 总长控制在 40 行内 —— 手机上不 scroll 到底
 *   2. 券的时间标注「还有几个可用时段」而非「还剩几天」
 *   3. 待办按「零成本 → 有成本」排序，写操作标注 [执行]
 *   4. 详细数据折叠，需要时再追问
 *
 * 本模块是纯函数，不碰 IO。
 */

import { planAssetAllocation } from "../analyze/asset-plan.mjs";
import { auditCoupons } from "../analyze/coupon-audit.mjs";
import { forecastOrders, scheduleCoupons } from "../analyze/coupon-schedule.mjs";
import { classify, parseCouponTerms } from "../analyze/coupon-model.mjs";
import { calibrateEarnRate } from "../analyze/ledger.mjs";
import { analyzePromotionRules } from "../analyze/promotion-rules.mjs";

/**
 * 渲染完整看板。
 *
 * @param {object} input
 * @param {object} input.snapshot
 * @param {object} input.diff
 * @param {string} [input.channel] 当前就餐方式
 * @param {number} [input.hour]     当前小时
 */
export function renderDashboard(input = {}, opts = {}) {
  const snap = input.snapshot || {};
  const diff = input.diff || {};
  const now = opts.now ? new Date(opts.now) : new Date();
  const channel = input.channel || opts.channel || null;
  const hour = input.hour ?? opts.hour;

  const coupons = (snap.coupons || []).map(enrich);
  const audit = auditCoupons(coupons, { now, channel, hour });

  // earnRate 回校：闭环的最后一环 —— 用本期真实数据修正补差金额
  const calibration = calibrateEarnRate(
    input.prevAccount,
    snap.account,
    diff.newOrders || []
  );

  const plan = planAssetAllocation(
    { account: snap.account, coupons, mall: snap.mall, lottery: snap.lottery, campaigns: snap.campaigns, orders: snap.orders },
    { now, channel, hour, earnRate: calibration.earnRate }
  );
  const forecast = forecastOrders(snap.orders || [], { now });
  const schedule = scheduleCoupons(coupons, forecast.orders, { now });

  const L = [];
  const today = now.toISOString().slice(0, 10);

  // ══ 标题 ══
  L.push(`🍔 **麦门日报 · ${today}**`);
  L.push("");

  // ══ 数据新鲜度提示 ══
  // 快照是旧的（比如回放历史数据）时，结论仍按「现在」算 —— 必须提示，
  // 否则用户会把过期的券/额度当成现状。
  const snapAt = snap.generatedAt ? new Date(snap.generatedAt) : null;
  if (snapAt && !Number.isNaN(snapAt.getTime())) {
    const ageHours = Math.floor((now.getTime() - snapAt.getTime()) / 3600000);
    if (ageHours >= 24) {
      L.push(`> ⚠️ 快照采集于 ${snapAt.toISOString().slice(0, 10)}（${Math.floor(ageHours / 24)} 天前），以下结论基于该时刻的数据。`);
      L.push("");
    }
  }

  // ══ 变化（如果有）══
  if (!diff.isFirstRun) {
    const changes = [];
    if (diff.newCampaigns?.length) {
      changes.push(`🆕 ${diff.newCampaigns.length} 个新活动`);
    }
    if (diff.newCoupons?.length) {
      changes.push(`🎫 ${diff.newCoupons.length} 张新券`);
    }
    if (diff.newOrders?.length) {
      changes.push(`🧾 你下了 ${diff.newOrders.length} 单`);
    }
    if (diff.usedCoupons?.length) {
      changes.push(`✅ 核销 ${diff.usedCoupons.length} 张券`);
    }
    const d = diff.account;
    if (d && d.availableDelta !== 0) {
      const sign = d.availableDelta > 0 ? "+" : "";
      changes.push(`💰 积分 ${sign}${d.availableDelta}`);
    }
    if (changes.length) {
      L.push(`**${changes.join(" · ")}**`);
      L.push("");
    }
  }

  // ══ 积分资产 ══
  const a = snap.account;
  if (a) {
    const decay = a.accumulative > 0 ? Math.round((a.expired / a.accumulative) * 1000) / 10 : 0;
    L.push(`💰 **积分** ${a.available} 可用 · ${a.accumulative} 累计${a.expired > 0 ? ` · ${a.expired} 已过期` : ""}`);
    const shadow = plan.valuation.shadow;
    if (shadow.price) {
      L.push(`　 1 积分 ≈ ¥${shadow.price.toFixed(4)}${shadow.reachableOnly ? "" : "（够不到最优档，仅作参照）"}`);
    }
    // earnRate 回校结果 —— 闭环的可见证据
    if (calibration.earnRate) {
      L.push(`　 📈 earnRate 实测 ${calibration.earnRate} 积分/元（${calibration.confidence === "high" ? "样本充足" : calibration.confidence === "medium" ? "样本一般" : "样本偏少"}）`);
    }
    if (a.expiringThisMonth > 0) {
      L.push(`　 ⚠️ ${a.expiringThisMonth} 积分本月过期（约 ¥${plan.valuation.points.expiringThisMonthYuan}）`);
    }
    if (decay >= 50) {
      L.push(`　 衰减率 ${decay}% —— 你的问题不是攒得少，是攒了没用`);
    }
    L.push("");
  }

  // ══ 券包 ══
  if (audit.total) {
    // ⚠️ 只有能确证的优惠额才计入金额合计。
    //    coupon_price 语义的券（用券价格 = 到手价）不能算作「省了 X 元」。
    //    但如果已经用 calculate-price 测算过（input.couponValues），
    //    就可以用测算出的真实优惠额 —— 这比「无法推算」有用得多。
    const measured = new Map(
      (input.couponValues?.items || [])
        .filter((x) => x.known)
        .map((x) => [x.id, x])
    );
    const measuredTotal = [...measured.values()].reduce((s, x) => s + (x.saving || 0), 0);
    const measuredCount = measured.size;

    const moneyNote =
      measuredCount > 0
        ? ` · 已测算 ${measuredCount} 张实省 ¥${Math.round(measuredTotal * 100) / 100}`
        : audit.silent.priceOnlyCount
          ? ` · ${audit.silent.priceOnlyCount} 张仅显示到手价（未计入金额）`
          : "";
    L.push(`🎫 **券包** ${audit.total} 张 · 可确证优惠 ¥${audit.totalValue}${moneyNote}`);
    const risky = audit.silent.atRiskItems.filter((x) => x.daysLeft >= 0 && x.daysLeft <= 7);
    const unusable = audit.unusable;
    const show = [...risky.slice(0, 4), ...unusable.slice(0, 2)].slice(0, 5);
    for (const item of show) {
      const tag = item.usableReason || (item.usableDays !== null ? `仅 ${item.usableDays} 天能用` : "");
      // 三种语义：已测算的实省 / 减免额券的省 / 到手价券的到手价
      const m = measured.get(item.id);
      const priceText = m
        ? `实省 ¥${m.saving}（原价 ¥${m.originalYuan} → ¥${m.payableYuan}）`
        : item.benefitKnown
          ? `省 ¥${item.benefit}`
          : item.value > 0
            ? `到手价 ¥${item.value}`
            : "面值未知";
      if (item.daysLeft !== undefined && item.daysLeft >= 0 && item.daysLeft <= 7) {
        L.push(`　 ⏰ ${item.name} ${priceText} 剩 ${item.daysLeft} 天${tag ? ` · ${tag}` : ""}`);
      } else {
        L.push(`　 ⏰ ${item.name} ${priceText} · ${item.reason}`);
      }
    }
    if (audit.unclaimed.length) {
      L.push(`　 🎫 ${audit.unclaimed.length} 张可领未领（零成本，先领）`);
    }
    if (audit.duplicates.length) {
      L.push(`　 💰 同款不同价 ${audit.duplicates.length} 组，可省 ¥${audit.duplicates[0].waste}`);
    }
    // ⚠️ 关键判断：券的有效期 vs 你的点餐节奏。
    //    实测（2026-10-23 真实数据）：券 10-29 到期，而按历史节奏（7 天一次）
    //    下次点餐在 10-30 —— **按平时的节奏等下去就会白白过期**。
    //    这句话比「还剩 7 天」有用得多：它改变的是「什么时候去」。
    if (forecast.cadenceDays && risky.length) {
      const finite = risky.map((x) => x.daysLeft).filter((n) => Number.isFinite(n));
      const shortest = finite.length ? Math.min(...finite) : null;
      if (shortest !== null && shortest <= forecast.cadenceDays) {
        L.push(
          `　 ⚠️ 你的点餐节奏约 ${forecast.cadenceDays} 天一次，而最短的券 ${shortest} 天后过期 —— 按老节奏等就会作废`
        );
      }
    }
    L.push("");
  }

  // ══ 门店优惠 ══
  // 这一节直接回答「这家店今天有什么优惠」。
  // ⚠️ 促销规则带 beTypes 渠道标记，且该接口忽略传入的 beType ——
  //    所以必须按渠道过滤，不适用的要明说「用不上」，不能当成可用优惠报出去。
  const promo = analyzePromotionRules(snap.promotions || [], { now, beType: channel === "delivery" ? 2 : 1 });
  if (promo.rules.length) {
    const storeName = snap.stores?.find((s) => s.storeCode === (input.storeCode || snap.storeCode))?.name;
    L.push(`🏪 **门店优惠**${storeName ? ` ${storeName}` : ""}`);
    if (promo.effective.length) {
      const b = promo.best;
      L.push(
        `　 ${promo.effective.length} 条满额减生效中 · 最优 ${b.best.title}（${(b.bestRate * 100).toFixed(1)}% off）`
      );      if (promo.decreasing) {
        L.push(`　 阶梯递减 → 最优策略是${promo.strategy}，不是买越多越省`);
      }
      // 同门槛多条规则：叠加与否接口未说明，如实告知
      const multi = promo.tiers.filter((t) => t.count > 1);
      if (multi.length) {
        const t = multi[0];
        L.push(
          `　 「满 ${t.threshold}」有 ${t.count} 条规则（减 ${t.rules.map((r) => r.discount).join("/")}），能否叠加接口未说明`
        );
      }
    } else {
      L.push(`　 ⚠️ 到店自取没有可用的满额减规则`);
    }
    if (promo.channelMismatch.length) {
      // 用 channelText（已映射成中文）而不是裸的 beTypes 数字
      const other = [...new Set(promo.channelMismatch.map((r) => r.channelText).filter(Boolean))].join("、");
      L.push(`　 另有 ${promo.channelMismatch.length} 条「${other || "其他渠道"}」规则，到店用不上`);
    }
    L.push("");
  }

  // ══ 今日活动 ══
  const todayCampaigns = (snap.campaigns || []).filter((c) => c.date === today);
  if (todayCampaigns.length) {
    const titles = todayCampaigns.flatMap((c) => c.titles || []);
    L.push(`🎁 **今日活动** ${titles.length} 个`);
    for (const t of titles.slice(0, 3)) L.push(`　 · ${t}`);
    if (titles.length > 3) L.push(`　 … 另有 ${titles.length - 3} 个`);
    L.push("");
  }

  // ══ 待办（按零成本 → 有成本）══
  if (plan.actions.length) {
    L.push("📌 **待办**");
    for (const act of plan.actions) {
      const exec = act.type === "claim_coupon" || act.type === "draw" ? " [执行]" : "";
      L.push(`　 ${act.priority}. ${act.title}${exec}`);
      if (act.reason && act.priority <= 2) L.push(`　 　 ${act.reason}`);
    }
    L.push("");
  }

  // ══ 抽奖 ══
  if (snap.lottery?.name && snap.lottery.drawPoint > 0) {
    const times = Math.floor((a?.available ?? 0) / snap.lottery.drawPoint);
    L.push(
      `🎰 **抽奖** ${snap.lottery.name} · ${snap.lottery.drawPoint} 积分/次 · 你可抽 ${times} 次`
    );
    L.push("");
  }

  // ══ 折叠的详细信息提示 ══
  const extras = [];
  if (audit.silent.atRiskCount > 0) extras.push(`过期风险明细 ${audit.silent.atRiskCount} 条`);
  if (schedule.assignments.length) extras.push(`用券排程 ${schedule.assignments.length} 条`);
  if (audit.duplicates.length) extras.push(`同款不同价 ${audit.duplicates.length} 组`);
  if (extras.length) {
    L.push(`> 追问可看：${extras.join(" · ")}`);
  }

  return L.join("\n");
}

/**
 * 渲染巡检终端报告（比看板更详细，含全部明细）。
 */
export function renderPatrol(result = {}) {
  const snap = result.snapshot || {};
  const diff = result.diff || {};
  const L = [];

  L.push("┌──────────────────────────────────────────────┐");
  L.push("│        🍔 麦门巡检 · MaiMen Patrol              │");
  L.push("└──────────────────────────────────────────────┘");
  L.push(`巡检时间：${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  if (result.store) L.push(`核对门店：${result.store}`);
  L.push("");

  // ---- 变化 ----
  if (diff.isFirstRun) {
    L.push("📌 首次巡检，已建立基线。下次运行即可看到变化。");
  } else {
    L.push("🔍 与上次的变化");
    const rows = [];
    if (diff.newCampaigns?.length) {
      rows.push(`🆕 新活动 ${diff.newCampaigns.length} 个：${diff.newCampaigns.map((c) => c.title).slice(0, 3).join("、")}`);
    }
    if (diff.newCoupons?.length) {
      rows.push(`🎫 新券 ${diff.newCoupons.length} 张：${diff.newCoupons.map((c) => c.name).slice(0, 3).join("、")}`);
    }
    if (diff.newMallItems?.length) {
      rows.push(`🛍️ 新增兑换标的 ${diff.newMallItems.length} 件`);
    }
    if (diff.delistedMallItems?.length) {
      rows.push(`⛔ 下架 ${diff.delistedMallItems.length} 件：${diff.delistedMallItems.map((m) => m.name).slice(0, 2).join("、")}`);
    }
    if (diff.newOrders?.length) {
      const o = diff.newOrders[0];
      rows.push(`🧾 你下了 ${diff.newOrders.length} 单（最近：${o.storeName} ¥${o.amount}）`);
    }
    if (diff.usedCoupons?.length) {
      rows.push(`✅ 核销 ${diff.usedCoupons.length} 张券：${diff.usedCoupons.map((c) => c.name).join("、")}`);
    }
    if (diff.account?.availableDelta) {
      const dd = diff.account.availableDelta;
      rows.push(`💰 积分变动 ${dd > 0 ? "+" : ""}${dd}`);
    }
    if (diff.expiringPoints?.thisMonth) {
      rows.push(`⏰ 本月 ${diff.expiringPoints.thisMonth} 积分到期`);
    }
    if (diff.expiringCoupons?.length) {
      rows.push(`⏰ ${diff.expiringCoupons.length} 张券 7 天内过期`);
    }
    if (diff.lottery?.changed) {
      rows.push(`🎰 抽奖变化：${diff.lottery.changes.join("；")}`);
    }
    if (rows.length) {
      for (const r of rows) L.push(`  ${r}`);
    } else {
      L.push("  与上次一致，无变化");
    }
    L.push("");
  }

  // ---- 资产概览 ----
  const a = snap.account;
  L.push("💰 积分账户");
  if (a) {
    L.push(`  可用 ${a.available} · 累计 ${a.accumulative} · 已用 ${a.used} · 已过期 ${a.expired}`);
    if (a.expiringThisMonth > 0) {
      L.push(`  ⚠️ 本月 ${a.expiringThisMonth} 分到期（${a.expiringNextMonth > 0 ? `下月还有 ${a.expiringNextMonth} 分` : ""}）`);
    }
  } else {
    L.push("  （未取到）");
  }
  L.push("");

  const live = (snap.mall || []).filter((m) => m.status === "live" && m.points > 0);
  L.push(`🛍️ 积分商城 ${(snap.mall || []).length} 件标���（在售积分类 ${live.length} 件）`);
  L.push("");

  L.push("🎫 券");
  const bySource = {};
  for (const c of snap.coupons || []) {
    bySource[c.source] = (bySource[c.source] || 0) + 1;
  }
  const sourceText = { "mcd-savers": "麦麦省可领", my: "卡包持有", store: "门店可用" };
  for (const [k, v] of Object.entries(bySource)) {
    L.push(`  ${sourceText[k] || k}：${v} 张`);
  }
  L.push("");

  if (result.claimed) {
    L.push("✅ 已执行一键领券");
    L.push("");
  }
  if (result.errors?.length) {
    L.push(`⚠ ${result.errors.length} 项采集失败：`);
    for (const e of result.errors) L.push(`  · ${e.tool}: ${e.error}`);
    L.push("");
  }

  L.push("—— 以上信息来自麦当劳官方 MCP 实时返回，以官方渠道为准 ——");
  return L.join("\n");
}

/** 给券补上类型判定与券面解析结果。 */
function enrich(coupon) {
  const c = classify(coupon);
  const terms = parseCouponTerms(coupon);
  return {
    ...coupon,
    type: c.type,
    typeConfident: c.confident,
    threshold: terms.threshold,
    discountPct: terms.discountPct,
    faceValue: coupon.value > 0 ? coupon.value : terms.faceValue,
  };
}
