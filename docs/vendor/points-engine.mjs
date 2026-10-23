/**
 * mcd-points-strategist · 积分资产优化核心引擎
 *
 * 零依赖，纯函数，可同时在 Node CLI 与浏览器 Demo 中运行。
 *
 * 核心洞察：麦当劳积分体系存在三处结构性 inefficiency——
 *   1. 兑换档位边际收益率递减（50 分档 ROI 远高于 800 分档）
 *   2. 门槛-余额错配死锁（可用积分够不到任何高 ROI 档位 → 积分注定过期）
 *   3. 沉没积分与零成本券的机会成本错配（积分能抽奖，但免费券不花积分）
 *
 * 本引擎把这三点量化，并给出可执行的处置顺序。
 */

/** 积分兑换通道：mall-create-order 仅支持 shopId=2 */
export const POINTS_REDEEM_SHOP_ID = 2;
/** 活动预约通道：party-order-create 仅支持 shopId=5 */
export const PARTY_SHOP_ID = 5;

/**
 * 计算兑换标的的「积分价值密度」——每 1 积分能换到多少元现金价值。
 *
 * 两个必须处理的现实约束（否则结论会系统性错误）：
 *   1. MCP 返回的商城列表含大量已下架标的（downTime < now），必须过滤。
 *      2026-10 实测：50 件标的中仅 7 件在售且可用积分兑换。
 *   2. point=0 的标的是现金购买（派对等），不属于积分资产，不参与 ROI 排名。
 */
export function computeDensity(item, now = new Date()) {
  if (!item || item.point <= 0) return null;
  const status = item.status || "live";
  if (status !== "live") return null;

  const face = num(item.faceValue ?? item.cashPrice);
  return {
    spuId: item.spuId,
    spuName: item.spuName,
    point: item.point,
    cashValue: face,
    // 元 / 积分
    density: round(face / item.point, 6),
    catName: item.catName,
    shopId: item.shopId,
    redeemable: item.shopId === POINTS_REDEEM_SHOP_ID,
    imageUrl: item.imageUrl || "",
    downTime: item.downTime || null,
  };
}

/** 全部标的按积分价值密度降序（仅 point>0 且在售） */
export function rankByDensity(mall, now = new Date()) {
  return (mall || [])
    .map((it) => computeDensity(it, now))
    .filter(Boolean)
    .sort((a, b) => b.density - a.density || a.point - b.point);
}

/**
 * 下架陷阱检测：MCP 商城列表会返回已过期的标的。
 * 若不剔除，用户会为了一个早已结束的活动去攒积分 —— 这是纯粹的浪费。
 */
export function detectDelistedTrap(mall, now = new Date()) {
  const all = mall || [];
  const expired = all.filter((it) => {
    if (!it.downTime) return false;
    const t = new Date(String(it.downTime).replace(" ", "T"));
    return !Number.isNaN(t.getTime()) && t < now;
  });
  const expiredWithPoints = expired.filter((it) => num(it.point) > 0);
  return {
    total: all.length,
    expiredCount: expired.length,
    expiredWithPoints: expiredWithPoints.length,
    liveRedeemable: all.filter((it) => num(it.point) > 0 && it.status === "live").length,
    warning:
      expiredWithPoints.length > 0
        ? `商城返回 ${all.length} 件标的中 ${expiredWithPoints.length} 件积分标的已下架，若不剔除会误导攒分`
        : null,
    samples: expiredWithPoints.slice(0, 3).map((it) => ({
      spuName: it.spuName,
      point: it.point,
      downTime: it.downTime,
    })),
  };
}

/**
 * 资产健康度评分（0-100）。
 * 四个维度加权：
 *   存活率 40% —— 累计积分中仍可用的比例（越高越好）
 *   变现率 25% —— 可用积分中能匹配到兑换标的的比例
 *   效率 25% —— 当前最优档位相对全站最优档位的密度比
 *   活力 10% —— 本月是否有临期压力（vitality 为安全度，越高越好）
 */
export function scoreHealth(account, mall) {
  const acc = num(account?.accumulativePoint);
  const avail = num(account?.availablePoint);
  const expired = num(account?.expiredPoint);
  const used = num(account?.usedPoint);

  const survival = acc > 0 ? clamp01(avail / acc) : 1;
  const ranked = rankByDensity(mall || []);
  const redeemable = ranked.filter((r) => r.redeemable);
  const bestDensity = ranked.length ? ranked[0].density : 0;

  const reachable = redeemable.filter((r) => r.point <= avail);
  const bestReachable = reachable.length
    ? Math.max(...reachable.map((r) => r.density))
    : 0;
  const realization = bestDensity > 0 ? clamp01(bestReachable / bestDensity) : 0;

  const efficiency = bestDensity > 0 ? clamp01(bestReachable / bestDensity) : 0;

  const expiring = num(account?.currentMouthExpirePoint);
  const vitality = avail > 0 ? clamp01(1 - expiring / avail) : 1;

  const score = Math.round(
    (survival * 0.4 + realization * 0.25 + efficiency * 0.25 + vitality * 0.1) * 100
  );

  return {
    score,
    grade: score >= 75 ? "健康" : score >= 50 ? "亚健康" : score >= 25 ? "预警" : "危险",
    dims: {
      survival: { value: round(survival, 4), weight: 0.4, label: "积分存活率" },
      realization: { value: round(realization, 4), weight: 0.25, label: "余额变现率" },
      efficiency: { value: round(efficiency, 4), weight: 0.25, label: "兑换效率" },
      vitality: { value: round(vitality, 4), weight: 0.1, label: "临期安全度" },
    },
    totals: { accumulative: acc, available: avail, expired, used },
    decayRate: acc > 0 ? round(expired / acc, 4) : 0,
  };
}

/**
 * 门槛-余额错配死锁检测。
 *
 * 若所有「高 ROI 档位」（密度位于前列且可兑换）的门槛都高于可用积分，
 * 则用户处于死锁：既换不到划算的东西，积分又会自然过期。
 * 返回距最近可达高 ROI 档位的补差距离。
 */
export function detectDeadlock(account, mall) {
  const avail = num(account?.availablePoint);
  const ranked = rankByDensity(mall || []).filter((r) => r.redeemable);
  if (!ranked.length) return { deadlocked: false, reason: "无可兑换标的" };

  // 高 ROI 集合：密度不低于全站最优 60% 的可兑换标的
  const threshold = ranked[0].density * 0.6;
  const highRoi = ranked.filter((r) => r.density >= threshold);
  const reachable = highRoi.filter((r) => r.point <= avail);

  if (reachable.length) {
    return {
      deadlocked: false,
      reason: `可用积分 ${avail} 已可匹配 ${reachable.length} 个高 ROI 档位`,
      bestReachable: reachable[0],
      highRoiCount: highRoi.length,
    };
  }

  // 找出补差最小的可达目标
  const candidates = highRoi
    .map((r) => ({ ...r, gap: round(r.point - avail, 2) }))
    .sort((a, b) => a.gap - b.gap);

  const nearest = candidates[0] || null;
  return {
    deadlocked: true,
    reason: `可用积分 ${avail} 低于所有高 ROI 档位门槛（最低 ${Math.min(...highRoi.map((r) => r.point))} 分）`,
    highRoiCount: highRoi.length,
    nearest,
    candidates: candidates.slice(0, 5),
  };
}

/**
 * 抽奖 vs 兑换 的期望值比较。
 *
 * MCP 的 query-lottery-info 不暴露奖品概率分布，因此不做点估计，
 * 而是给出「价值区间」+「盈亏平衡概率」——这是可证伪的诚实做法：
 *   若抽中「实物大奖」的概率 > breakEvenProb，则抽奖优于直接兑换。
 *
 * @param {object} opts
 * @param {number} opts.availablePoint   可用积分
 * @param {object} opts.lottery           抽奖活动信息
 * @param {Array}  opts.mall              积分商城标的（用于算最佳兑换密度）
 * @param {Array}  opts.itemValues       各奖品的名义现金价值（由调用方提供或推断）
 */
export function compareLotteryVsRedeem({ availablePoint, lottery, mall = [], itemValues = [] }) {
  const drawPoint = num(lottery?.drawPoint);
  const ranked = rankByDensity(mall);
  const bestDensity = ranked.length ? ranked[0].density : 0;

  if (!drawPoint || !lottery) {
    return { available: false, reason: "当前无抽奖活动或消耗规则不可用" };
  }

  const maxDraws = Math.floor(num(availablePoint) / drawPoint);
  // 直接兑换同样积分能拿到的现金价值
  const redeemValue = round(drawPoint * bestDensity, 2);

  const prizes = (lottery.prizes || []).map((p) => ({
    name: p.name,
    typeText: p.typeText,
    imageUrl: p.imageUrl || "",
    value: itemValues.find((v) => v.name === p.name)?.value ?? null,
  }));

  const known = prizes.filter((p) => p.value != null);
  if (!known.length) {
    return {
      available: true,
      drawPoint,
      maxDraws,
      redeemValue,
      prizes,
      note: "MCP 未暴露奖品概率分布，无法计算点估计期望值；请提供奖品价值表以启用盈亏平衡分析。",
    };
  }

  const values = known.map((p) => p.value);
  const worst = Math.min(...values);
  const best = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;

  // 盈亏平衡：抽中最高价值的概率需要达到多少，抽奖才不劣于兑换
  const gap = best - redeemValue;
  const breakEvenProb = gap > 0 ? round((redeemValue - worst) / gap, 4) : 0;

  return {
    available: true,
    drawPoint,
    maxDraws,
    redeemValue,
    prizes,
    valueRange: { worst, best, avg },
    breakEvenProb,
    verdict:
      breakEvenProb > 0
        ? `抽奖优于兑换的盈亏平衡点：抽中最高价值奖品概率需 > ${(breakEvenProb * 100).toFixed(1)}%`
        : "抽奖的最低价值已不低于直接兑换，建议优先抽奖",
  };
}

/**
 * 0/1 背包：每件商品单独成单（符合 mall-create-order「单个商品一个订单」的约束），
 * 在积分预算内最大化现金价值。
 *
 * @param {Array}  items    兑换标的（point>0）
 * @param {number} budget   可用积分
 * @param {object} opts
 * @param {number} opts.minDensity  只接受密度不低于此值的标的（保质期优先时调高）
 */
export function solveRedeemPlan(items, budget, opts = {}) {
  const { minDensity = 0, now = new Date() } = opts;
  const pool = (items || [])
    .filter((it) => num(it.point) > 0 && it.shopId === POINTS_REDEEM_SHOP_ID)
    .map((it) => computeDensity(it, now))
    .filter((d) => d && d.density >= minDensity);

  if (!pool.length) return { plan: [], totalPoint: 0, totalCash: 0, note: "无可兑换标的" };

  const cap = Math.max(0, Math.floor(budget));
  const n = pool.length;
  if (cap === 0) {
    return {
      plan: [], totalPoint: 0, totalCash: 0, leftover: 0, density: 0, frontier: [],
      note: `可用积分 ${cap} 不足以兑换任何标的（最低门槛 ${Math.min(...pool.map((p) => p.point))} 分）`,
    };
  }
  // dp[i][c] = 用前 i 件、总分不超过 c 时的最大现金价值
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(cap + 1).fill(0));
  const pick = Array.from({ length: n + 1 }, () => new Array(cap + 1).fill(false));

  for (let i = 1; i <= n; i++) {
    const it = pool[i - 1];
    for (let c = 0; c <= cap; c++) {
      dp[i][c] = dp[i - 1][c];
      pick[i][c] = false;
      if (it.point <= c) {
        const v = dp[i - 1][c - it.point] + it.cashValue;
        if (v > dp[i][c]) {
          dp[i][c] = v;
          pick[i][c] = true;
        }
      }
    }
  }

  // 回溯
  const plan = [];
  let c = cap;
  for (let i = n; i >= 1; i--) {
    if (pick[i][c]) {
      plan.push(pool[i - 1]);
      c -= pool[i - 1].point;
    }
  }
  plan.reverse();

  const totalPoint = plan.reduce((s, p) => s + p.point, 0);
  const totalCash = round(plan.reduce((s, p) => s + p.cashValue, 0), 2);
  const leftover = cap - totalPoint;

  // 帕累托前沿：在「花得更多」与「换得更值」之间找非支配解
  const frontier = buildParetoFrontier(pool, cap);

  return {
    plan,
    totalPoint,
    totalCash,
    leftover,
    density: totalPoint > 0 ? round(totalCash / totalPoint, 4) : 0,
    frontier,
    note:
      plan.length === 0
        ? `可用积分 ${cap} 不足以兑换任何标的（最低门槛 ${Math.min(...pool.map((p) => p.point))} 分）`
        : `兑换 ${plan.length} 件，实付 ${totalPoint} 分，剩余 ${leftover} 分`,
  };
}

/** 帕累托前沿：非支配解集合（换得值更高 且 花分更少） */
export function buildParetoFrontier(items, budget) {
  const feasible = items
    .filter((it) => it.point <= budget)
    .map((it) => ({
      spuId: it.spuId,
      spuName: it.spuName,
      point: it.point,
      cashValue: it.cashValue,
      density: it.density,
    }))
    .sort((a, b) => a.point - b.point || b.cashValue - a.cashValue);

  const frontier = [];
  let maxCash = -1;
  for (const it of feasible) {
    if (it.cashValue > maxCash) {
      frontier.push(it);
      maxCash = it.cashValue;
    }
  }
  return frontier;
}

/**
 * 积分获取速率估算。
 * 麦当劳麦麦会员体系下，1 元消费约得 1 积分（可用历史订单校验）。
 * 此处保留 earnRate 参数以便用户按实际订单校准。
 */
export function estimateEarnRate({ orders = [], fallback = 1 } = {}) {
  const usable = orders.filter(
    (o) => num(o.realTotalAmount) > 0 && num(o.earnPoint) > 0
  );
  if (!usable.length) return fallback;
  const rate =
    usable.reduce((s, o) => s + num(o.earnPoint) / num(o.realTotalAmount), 0) /
    usable.length;
  return round(rate, 4);
}

/**
 * 补差规划：为了够到某个高 ROI 档位，还需要消费多少钱。
 */
export function planToTarget(target, availablePoint, earnRate = 1) {
  const gap = round(Math.max(0, num(target.point) - num(availablePoint)), 2);
  const spendNeeded = round(gap / (earnRate || 1), 2);
  return {
    gap,
    spendNeeded,
    earnRate,
    note:
      gap === 0
        ? "已达标，可立即兑换"
        : `还需消费约 ¥${spendNeeded}（按 ${earnRate} 积分/元）可凑到 ${target.point} 分门槛`,
  };
}

/**
 * 处置建议排序：把所有可选动作按「即时收益 / 成本」排序。
 * 动作类型：领免费券、抽奖、兑换、补差消费。
 */
export function buildActionPlan({ account, mall, lottery, coupons = [], orders = [] }) {
  const avail = num(account?.availablePoint);
  const actions = [];
  const trap = detectDelistedTrap(mall || []);

  const freeCoupons = coupons.filter((c) => /免费|0元|立减|买1送1|随心配/i.test(c.title || ""));
  if (freeCoupons.length) {
    actions.push({
      type: "claim_coupon",
      priority: 1,
      title: `领取 ${freeCoupons.length} 张零成本优惠券`,
      detail: freeCoupons.map((c) => c.title).join("、"),
      cost: 0,
      reason: "优惠券不消耗积分，先领完再谈积分，避免沉没",
    });
  }

  const ranked = rankByDensity(mall || []);
  const deadlock = detectDeadlock(account, mall || []);

  if (trap.expiredWithPoints > 0) {
    actions.push({
      type: "avoid_trap",
      priority: 2,
      title: `避开 ${trap.expiredWithPoints} 个已下架标的`,
      detail: trap.samples.map((s) => `${s.spuName}（${s.point}分，已于 ${s.downTime} 下架）`).join("、"),
      cost: 0,
      reason: "为已结束的活动攒积分是纯浪费，MCP 商城列表不会自动过滤它们",
    });
  }

  if (deadlock.deadlocked && deadlock.nearest) {
    const earnRate = estimateEarnRate({ orders });
    const plan = planToTarget(deadlock.nearest, avail, earnRate);
    actions.push({
      type: "top_up",
      priority: 3,
      title: `补差消费 ${plan.spendNeeded} 元以解锁高 ROI 档位`,
      detail: `目标「${deadlock.nearest.spuName}」需 ${deadlock.nearest.point} 分（密度 ${deadlock.nearest.density} 元/分），当前差 ${plan.gap} 分`,
      cost: plan.spendNeeded,
      reason: "处于门槛-余额错配死锁：不补差则积分注定过期",
    });
  }

  const drawPoint = num(lottery?.drawPoint);
  if (drawPoint > 0 && avail >= drawPoint) {
    actions.push({
      type: "draw",
      priority: 4,
      title: `用 ${drawPoint} 积分抽奖 ${Math.floor(avail / drawPoint)} 次`,
      detail: `${lottery.activityName || "积分抽奖"}，${lottery.drawTypeText || ""}`,
      cost: drawPoint,
      reason: "把即将过期的沉没积分转成实物/券期望值",
    });
  }

  const solve = solveRedeemPlan(mall || [], avail);
  if (solve.plan.length) {
    actions.push({
      type: "redeem",
      priority: 5,
      title: `兑换 ${solve.plan.length} 件商品，实得 ¥${solve.totalCash}`,
      detail: solve.plan.map((p) => `${p.spuName}（${p.point}分→¥${p.cashValue}）`).join("、"),
      cost: solve.totalPoint,
      reason: `整体密度 ${solve.density} 元/分`,
    });
  }

  return actions.sort((a, b) => a.priority - b.priority);
}

// ---------- 工具函数 ----------
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round(v * f) / f;
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ---------- 浏览器 / UMD 导出 ----------
// 同一份引擎同时服务于 Node CLI 与 GitHub Pages Demo，保证两者结论完全一致。
if (typeof globalThis !== "undefined") {
  globalThis.MCDPointsEngine = {
    POINTS_REDEEM_SHOP_ID,
    PARTY_SHOP_ID,
    computeDensity,
    rankByDensity,
    detectDelistedTrap,
    detectDeadlock,
    solveRedeemPlan,
    scoreHealth,
    compareLotteryVsRedeem,
    buildParetoFrontier,
    estimateEarnRate,
    planToTarget,
    buildActionPlan,
  };
}
