/**
 * mcd-points-strategist · 统一资产运营引擎
 *
 * 把**积分**与**优惠券**放在同一张表上比较，再决定「先花哪个」。
 *
 * 核心思想：把所有资源折算成「元 / 单位」。
 *
 *   积分影子价格 = 兑换品面值 / 所需积分        (元/分)
 *   券有效率     = 可用券实际节省 / 券面值      (0~1)
 *   抽奖价值     = 盈亏平衡概率法               (不给点估计)
 *   活动价值     = 不定价，只做时间线提醒
 *
 * **积分影子价格是本项目的关键**。有了它：
 *   - 1 积分值 ¥0.138 → 800 积分 = ¥110.4
 *   - 一张 ¥13.5 的券 = 98 积分
 *   - 于是「该用券还是该攒分」变成一道可计算的题
 *
 * 目前 30 个高星参赛项目里，只有 1 个做过积分影子价格
 * （maimai-saver #23，115★）。本项目把它做成体系。
 *
 * 本模块是纯函数，不碰 IO。
 */

// --------------------------------------------------------------------------
// 积分影子价格
// --------------------------------------------------------------------------

/**
 * 计算积分影子价格 —— 1 积分值多少元。
 *
 * 做法：取**当前余额能达到的**兑换标的中密度最高的那一个。
 *
 * 为什么用「能达到的」而不是「全站最优」：
 *   全站最优档可能是 800 分档（密度 0.0274），但你只有 33.5 分 ——
 *   那个密度对你没有意义。真正能指导决策的是
 *   「你手上的积分能换到的最好档位」。
 *
 * @param {Array}  mall  商城标的
 * @param {object} account 积分账户
 * @param {object} opts
 * @param {Date}   [opts.now]
 */
export function computeShadowPrice(mall = [], account = {}, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const available = account?.available ?? 0;

  const live = (mall || []).filter(
    (m) => m.status === "live" && (m.points ?? 0) > 0 && (m.faceValue ?? 0) > 0
  );

  if (!live.length) {
    return {
      price: 0,
      best: null,
      reachable: [],
      note: "当前没有在售的积分兑换标的，无法计算影子价格",
    };
  }

  const withDensity = live.map((m) => ({
    ...m,
    density: (m.faceValue ?? 0) / (m.points ?? 1),
  }));

  // 全站最优（不管够不够得到）—— 作为机会成本的参照
  const bestOverall = withDensity.reduce((a, b) => (a.density >= b.density ? a : b));

  // 你能达到的最优档 —— 这才是行动指导
  const reachable = withDensity
    .filter((m) => m.points <= available)
    .sort((a, b) => b.density - a.density);

  const best = reachable[0] || null;

  return {
    // 影子价格：优先用能达到的最优档；够不到任何档时退化为全站最优（仅作参照）
    price: best ? round(best.density, 6) : round(bestOverall.density, 6),
    reachableOnly: !!best,
    best,
    bestOverall,
    reachable,
    note: best
      ? `按你当前 ${available} 分能达到的最优档「${best.name}」（${best.points} 分 → ¥${best.faceValue}）计算`
      : `当前 ${available} 分够不到任何在售档位，影子价格暂用全站最优档「${bestOverall.name}」作参照`,
  };
}

/**
 * 把任意金额换算成等值积分。
 *
 * @param {number} yuan 金额
 * @param {number} shadowPrice 元/分
 */
export function yuanToPoints(yuan, shadowPrice) {
  if (!shadowPrice || shadowPrice <= 0) return null;
  return round(yuan / shadowPrice, 1);
}

/**
 * 把任意积分数换算成等值金额。
 */
export function pointsToYuan(points, shadowPrice) {
  if (shadowPrice === null || shadowPrice === undefined) return null;
  return round((points ?? 0) * shadowPrice, 2);
}

// --------------------------------------------------------------------------
// 资源折算
// --------------------------------------------------------------------------

/**
 * 把所有资源折算成统一口径。
 *
 * @param {object} input
 * @param {object} input.account
 * @param {Array}  input.coupons
 * @param {Array}  input.mall
 * @param {object} input.lottery
 */
export function valueAllResources(input = {}, opts = {}) {
  const { account, coupons = [], mall = [], lottery = null } = input;

  const shadow = computeShadowPrice(mall, account, opts);

  // 券的折算：面值 → 等值积分 → 占可用积分的比例
  const couponValues = coupons.map((c) => {
    const pointsWorth = c.value > 0 ? yuanToPoints(c.value, shadow.price) : null;
    return {
      name: c.name,
      value: c.value,
      pointsWorth,
      // 这张券占你可用积分的多少 —— 大于 100% 说明它比积分更值钱
      shareOfBalance: pointsWorth && account?.available
        ? round((pointsWorth / account.available) * 100, 1)
        : null,
      source: c.source,
      expireAt: c.expireAt,
      daysLeft: c.daysLeft ?? null,
      usableDays: c.usableSlots ?? null,
    };
  });

  // 积分资产折算
  const pointsValue = {
    available: account?.available ?? 0,
    yuanWorth: pointsToYuan(account?.available ?? 0, shadow.price),
    expiringThisMonth: account?.expiringThisMonth ?? 0,
    expiringThisMonthYuan: pointsToYuan(account?.expiringThisMonth ?? 0, shadow.price),
    expired: account?.expired ?? 0,
    expiredYuan: pointsToYuan(account?.expired ?? 0, shadow.price),
  };

  return {
    shadow,
    points: pointsValue,
    coupons: couponValues,
    totalCouponValue: round(couponValues.reduce((s, c) => s + (c.value > 0 ? c.value : 0), 0)),
    totalCouponPointsWorth: round(
      couponValues.reduce((s, c) => s + (c.pointsWorth || 0), 0),
      1
    ),
    note: shadow.price
      ? `1 积分 ≈ ¥${shadow.price.toFixed(4)}`
      : "无法折算（缺少在售兑换标的）",
  };
}

// --------------------------------------------------------------------------
// 联合决策
// --------------------------------------------------------------------------

/**
 * 积分 × 券的联合决策。
 *
 * 回答一个具体问题：**你现在有 800 积分和一张 ¥30 的券，该怎么花？**
 *
 * 至少四个选项：
 *   A. 全换积分（800 分 → 高密度档）
 *   B. 全用券（券抵 ¥30）
 *   C. 券优先 + 积分补差（攒分跨门槛）
 *   D. 先抽奖把沉没积分转成实物，券留着
 *
 * 输出按「净收益 ÷ 成本」排序的动作清单。
 *
 * @param {object} input
 * @param {object} input.account
 * @param {Array}  input.coupons
 * @param {Array}  input.mall
 * @param {object} input.lottery
 * @param {Array}  input.campaigns
 * @param {Array}  input.orders
 */
export function planAssetAllocation(input = {}, opts = {}) {
  const { account, coupons = [], mall = [], lottery = null, campaigns = [], orders = [] } = input;
  const now = opts.now ? new Date(opts.now) : new Date();

  const valuation = valueAllResources(input, { ...opts, now });
  const shadow = valuation.shadow;
  const actions = [];

  // ── 优先级 1：领券（零成本，且不领就会消失）──
  const claimable = coupons.filter((c) => c.status === "可领取");
  if (claimable.length) {
    actions.push({
      type: "claim_coupon",
      priority: 1,
      title: `领取 ${claimable.length} 张可领券`,
      detail: claimable.map((c) => c.name).join("、"),
      cost: { points: 0, yuan: 0 },
      gain: { yuan: null, note: "券面价值需领到手后才知道" },
      reason: "优惠券不消耗积分，零成本零风险 —— 先领完再谈积分，避免沉没",
    });
  }

  // ── 优先级 2：临期资产告警 ──
  const expiringPoints = account?.expiringThisMonth ?? 0;
  if (expiringPoints > 0) {
    actions.push({
      type: "points_expiring",
      priority: 2,
      title: `${expiringPoints} 积分本月到期（约 ¥${valuation.points.expiringThisMonthYuan}）`,
      detail: "到期即清零，是确定的损失",
      cost: { points: 0, yuan: 0 },
      gain: { yuan: valuation.points.expiringThisMonthYuan },
      reason: "临期积分按影子价格算已经值这个数，不用就等于白扔",
    });
  }

  const expiringCoupons = coupons.filter((c) => {
    if (!c.expireAt) return false;
    const d = (new Date(c.expireAt).getTime() - now.getTime()) / 86400000;
    return d >= 0 && d <= (opts.expiringWithinDays ?? 7);
  });
  if (expiringCoupons.length) {
    // ⚠️ 只用 `benefit`（可确证的优惠金额）折算积分。
    //    coupon_price 语义的券（用券价格 = 到手价）benefit 为 null ——
    //    把到手价当优惠额折算，会得出「这张券值 148 积分」的荒谬结论。
    //    这类券只能提示「尽快用掉」，不能参与金额折算。
    const isKnown = (c) =>
      c.benefitKnown !== undefined
        ? c.benefitKnown === true
        : c.valueKind !== "coupon_price" && Number(c.value) > 0;
    const valuable = expiringCoupons.filter(isKnown);
    const totalValue = round(valuable.reduce((s, c) => s + (Number(c.value) || 0), 0));
    const totalPoints = round(
      valuable.reduce(
        (s, c) => s + (yuanToPoints(Number(c.value) || 0, shadow.price) || 0),
        0
      ),
      1
    );
    const unquantified = expiringCoupons.length - valuable.length;

    actions.push({
      type: "coupon_expiring",
      priority: 2,
      title:
        valuable.length > 0
          ? `${expiringCoupons.length} 张券 7 天内过期（可确证优惠 ¥${totalValue}）`
          : `${expiringCoupons.length} 张券 7 天内过期`,
      detail: expiringCoupons
        .map((c) => `${c.name}${c.usableSlots !== null ? `（仅 ${c.usableSlots} 天能用）` : ""}`)
        .join("、"),
      cost: { points: 0, yuan: 0 },
      gain: {
        yuan: totalValue,
        points: totalPoints,
        // 无法折算的张数 —— 渲染层要单独说明，不能混进金额
        unquantified: unquantified,
      },
      reason:
        valuable.length > 0
          ? `这些券合计约等于 ${totalPoints} 积分，按影子价格 ¥${shadow.price.toFixed(4)}/分 折算` +
            (unquantified ? `；另有 ${unquantified} 张只能看到用券价格，未折算` : "")
          : "这些券只能看到用券价格（到手价），无法推算实际优惠额，但同样会过期 —— 尽快用掉",
    });
  }

  // ── 优先级 3：抽奖（把沉没积分转成实物/券）──
  if (lottery?.drawPoint > 0 && (account?.available ?? 0) >= lottery.drawPoint) {
    const times = Math.floor((account?.available ?? 0) / lottery.drawPoint);
    const redeemValue = pointsToYuan(lottery.drawPoint, shadow.price);
    actions.push({
      type: "draw",
      priority: 3,
      title: `用 ${lottery.drawPoint} 积分抽奖，可抽 ${times} 次`,
      detail: `${lottery.name || "积分抽奖"} · ${lottery.drawType || ""}`,
      cost: { points: lottery.drawPoint * times, yuan: redeemValue * times },
      gain: { yuan: null, note: "MCP 不公布中奖概率，只能给盈亏平衡点" },
      reason: redeemValue
        ? `这些积分直接换约 ¥${redeemValue}；抽奖是否更划算取决于中奖概率`
        : "沉没积分的变现途径",
    });
  }

  // ── 优先级 4：兑换（把积分换成券/实物）──
  const best = shadow.best;
  if (best) {
    actions.push({
      type: "redeem",
      priority: 4,
      title: `兑换「${best.name}」`,
      detail: `${best.points} 积分 → ¥${best.faceValue}（密度 ${best.density.toFixed(4)} 元/分）`,
      cost: { points: best.points, yuan: null },
      gain: { yuan: best.faceValue, points: -best.points },
      reason: `这是你当前余额能达到的最优档位（全站最优是「${shadow.bestOverall.name}」，密度 ${shadow.bestOverall.density.toFixed(4)}）`,
    });
  } else {
    // 够不到任何档 → 死锁，给补差方案
    const candidate = shadow.bestOverall;
    if (candidate && (account?.available ?? 0) > 0) {
      const gap = round(candidate.points - (account?.available ?? 0), 1);
      // earnRate 来自账本校准（M5 闭环回校）。默认 1.0 是兜底，不是实测。
      const earnRate = num(opts.earnRate) || 1;
      const spendNeeded = round(gap / earnRate, 2);
      const calibrated = num(opts.earnRate) > 0;
      actions.push({
        type: "deadlock",
        priority: 4,
        title: `当前余额够不到任何在售档位`,
        detail: `最优档「${candidate.name}」需 ${candidate.points} 分，差 ${gap} 分`,
        cost: { points: 0, yuan: spendNeeded },
        gain: { yuan: candidate.faceValue },
        reason: calibrated
          ? `处于门槛-余额错配死锁 —— 再消费约 ¥${spendNeeded}（按实测 ${earnRate} 积分/元）即可跨过门槛`
          : `处于门槛-余额错配死锁 —— 再消费约 ¥${spendNeeded} 即可跨过门槛（earnRate 用默认值 1，尚未校准）`,
        gap,
        spendNeeded,
        earnRate,
        earnRateCalibrated: calibrated,
        target: candidate,
      });
    }
  }

  // ── 优先级 5：活动提醒（只做时间线，不定价）──
  const todayStr = now.toISOString().slice(0, 10);
  const todayCampaigns = campaigns.filter((c) => c.date === todayStr);
  if (todayCampaigns.length) {
    // ⚠️ 口径一致性：这里数的是**活动条数**（一天可能有多个活动），
    //    不是天数。看板的「今日活动 N 个」也是条数 —— 两边必须一致，
    //    否则会出现「今日活动 14 个」但待办说「今天有 1 个活动」的自相矛盾。
    const todayTitles = todayCampaigns.flatMap((c) => c.titles || []);
    actions.push({
      type: "campaign",
      priority: 5,
      title: `今天有 ${todayTitles.length} 个活动`,
      detail: todayTitles.slice(0, 5).join("、"),
      cost: { points: 0, yuan: 0 },
      gain: { yuan: null, note: "活动文案里的价格不可核实，不计入计算" },
      reason: "活动与券的有效期对起来看 —— 券撑不撑得到活动那天",
    });
  }

  actions.sort((a, b) => a.priority - b.priority);

  return {
    generatedAt: now.toISOString(),
    valuation,
    actions,
    headline: buildHeadline(valuation, actions),
    note: buildNote(valuation),
  };
}

// --------------------------------------------------------------------------
// 表述
// --------------------------------------------------------------------------

function buildHeadline(valuation, actions) {
  const parts = [];
  if (valuation.points.available > 0) {
    parts.push(`积分 ${valuation.points.available} 分（约 ¥${valuation.points.yuanWorth}）`);
  }
  if (valuation.totalCouponValue > 0) {
    parts.push(`券面值 ¥${valuation.totalCouponValue}（约 ${valuation.totalCouponPointsWorth} 积分）`);
  }
  const urgent = actions.filter((a) => a.priority <= 2);
  if (urgent.length) {
    parts.push(`${urgent.length} 项待处理`);
  }
  return parts.join(" · ");
}

function buildNote(valuation) {
  const s = valuation.shadow;
  if (!s.price) return "无法折算";
  if (!s.reachableOnly) {
    return `${s.note}。当前余额够不到任何在售档位，影子价格仅作参照 —— 优先考虑补差或抽奖。`;
  }
  return `${s.note}。据此，1 张 ¥13.5 的券 ≈ ${Math.round(13.5 / s.price)} 积分，可以直接比大小。`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round((v ?? 0) * f) / f;
}
