/**
 * mcd-points-strategist · 快照增量对比
 *
 * 回答一个问题：**从上次看到现在，发生了什么变化？**
 *
 * 这是「每天自动检测」的落点。MCP 没有推送、没有 webhook，
 * 所以「变化」只能靠**两次快照的差分**来发现。
 *
 * 三类变化值得报告：
 *   🆕 新增   —— 新的活动、新的可领券、新的兑换标的
 *   ⏰ 临期   —— 本月过期的积分、7 天内过期的券
 *   ✅ 已完成 —— 你在手机上下了一单（用 orderId 识别），券核销了、积分入账了
 *
 * 本模块是纯函数，不碰 IO。
 */

/**
 * 对比两份快照。
 *
 * @param {object} prev 上一次快照（可为 null，表示首次运行）
 * @param {object} curr 当前快照
 * @param {object} opts
 * @param {Date}   [opts.now]
 * @param {number} [opts.expiringWithinDays] 券的临期窗口（默认 7）
 * @returns {object} 增量报告
 */
export function diffSnapshots(prev, curr, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const within = opts.expiringWithinDays ?? 7;

  const first = !prev;
  const p = first ? emptyIndex() : indexSnapshot(prev);
  const c = indexSnapshot(curr);

  // 增量集合先算出来，后面多处引用
  const newCampaigns = first ? [] : diffBy(p.campaignKeys, c.campaignKeys, c.campaignMap);
  const newCoupons = first ? [] : diffBy(p.couponKeys, c.couponKeys, c.couponMap);
  const newMallItems = first ? [] : diffBy(p.mallKeys, c.mallKeys, c.mallMap);

  return {
    isFirstRun: first,
    generatedAt: now.toISOString(),
    prevGeneratedAt: prev?.generatedAt ?? null,

    // ── 新增 ──
    newCampaigns,
    newCoupons,
    newMallItems,

    // ── 下架 ──
    delistedMallItems: first ? [] : [...p.mallMap.values()].filter(
      (m) => m.status === "live" && c.mallMap.get(String(m.spuId))?.status !== "live"
    ),
    expiredCoupons: first ? [] : [...p.couponMap.values()].filter(
      (x) => !c.couponMap.has(x.key)
    ),

    // ── 临期 ──
    expiringCoupons: [...c.couponMap.values()].filter((x) => {
      if (!x.expireAt) return false;
      const d = new Date(x.expireAt);
      const diff = (d.getTime() - now.getTime()) / 86400000;
      return diff >= 0 && diff <= within;
    }),
    expiringPoints: {
      thisMonth: curr?.account?.expiringThisMonth ?? 0,
      nextMonth: curr?.account?.expiringNextMonth ?? 0,
    },

    // ── 状态变化 ──
    account: diffAccount(prev, curr),

    // ── 你下了一单 ──
    newOrders: first ? [] : (curr?.orders || []).filter((o) => !p.orderIds.has(o.orderId)),
    usedCoupons: first ? [] : detectUsedCoupons(prev, curr, now),

    // ── 抽奖变化 ──
    lottery: diffLottery(prev, curr),

    // ── 摘要 ──
    summary: buildSummary({ first, newCampaigns, newCoupons }, now),
  };
}

// --------------------------------------------------------------------------
// 索引
// --------------------------------------------------------------------------

function emptyIndex() {
  return {
    campaignKeys: new Set(),
    campaignMap: new Map(),
    couponKeys: new Set(),
    couponMap: new Map(),
    mallKeys: new Set(),
    mallMap: new Map(),
    orderIds: new Set(),
  };
}

/**
 * 给快照建立索引。
 *
 * 券的去重键是「券名 + 有效期」而不是 id —— MCP 返回的 id 在不同次调用间
 * 不稳定（实测同一张券两次拉取的 couponId 不同），但「券名+有效期」稳定。
 */
function indexSnapshot(snap) {
  const idx = emptyIndex();
  if (!snap) return idx;

  for (const c of snap.campaigns || []) {
    for (const t of c.titles || []) {
      const key = `${c.date}|${t}`;
      idx.campaignKeys.add(key);
      idx.campaignMap.set(key, { date: c.date, title: t, phase: c.phase });
    }
  }

  for (const x of snap.coupons || []) {
    const key = `${x.name}|${x.expireAt || ""}`;
    idx.couponKeys.add(key);
    idx.couponMap.set(key, x);
  }

  for (const m of snap.mall || []) {
    const key = String(m.spuId);
    idx.mallKeys.add(key);
    idx.mallMap.set(key, m);
  }

  for (const o of snap.orders || []) {
    idx.orderIds.add(o.orderId);
  }

  return idx;
}

function diffBy(prevKeys, currKeys, currMap) {
  const out = [];
  for (const k of currKeys) {
    if (!prevKeys.has(k)) out.push(currMap.get(k));
  }
  return out;
}

// --------------------------------------------------------------------------
// 细项对比
// --------------------------------------------------------------------------

function diffAccount(prev, curr) {
  if (!prev?.account || !curr?.account) return null;
  const a = prev.account;
  const b = curr.account;
  return {
    availableDelta: round((b.available ?? 0) - (a.available ?? 0)),
    accumulativeDelta: round((b.accumulative ?? 0) - (a.accumulative ?? 0)),
    usedDelta: round((b.used ?? 0) - (a.used ?? 0)),
    expiredDelta: round((b.expired ?? 0) - (a.expired ?? 0)),
    before: a,
    after: b,
  };
}

/**
 * 推断哪些券被用掉了。
 *
 * 券用掉后从卡包消失 —— 所以「上次有、这次没有，且还没到期」= 被核销了。
 */
function detectUsedCoupons(prev, curr, now) {
  if (!prev?.coupons || !curr?.coupons) return [];
  const nowTs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const currKeys = new Set(curr.coupons.map((x) => `${x.name}|${x.expireAt || ""}`));
  const out = [];

  for (const x of prev.coupons) {
    const key = `${x.name}|${x.expireAt || ""}`;
    if (currKeys.has(key)) continue;
    // 还在有效期内却消失了 → 是被用掉了，不是过期
    if (x.expireAt && new Date(x.expireAt).getTime() > nowTs) {
      out.push({ name: x.name, value: x.value, expireAt: x.expireAt, source: x.source });
    }
  }
  return out;
}

function diffLottery(prev, curr) {
  if (!prev?.lottery || !curr?.lottery) return null;
  const a = prev.lottery;
  const b = curr.lottery;
  const changes = [];
  if (a.name !== b.name) changes.push(`活动改为「${b.name}」`);
  if (a.drawPoint !== b.drawPoint) changes.push(`单次消耗从 ${a.drawPoint} 改为 ${b.drawPoint} 积分`);
  if (a.status !== b.status) changes.push(`状态：${a.status} → ${b.status}`);
  if (a.resourceEligible !== b.resourceEligible) {
    changes.push(b.resourceEligible ? "现在可以参与了" : "暂时不能参与");
  }
  const prevPrizes = new Set((a.prizes || []).map((p) => p.name));
  const newPrizes = (b.prizes || []).filter((p) => !prevPrizes.has(p.name));
  if (newPrizes.length) {
    changes.push(`新增奖品：${newPrizes.map((p) => p.name).join("、")}`);
  }
  return { changed: changes.length > 0, changes, current: b };
}

// --------------------------------------------------------------------------
// 摘要
// --------------------------------------------------------------------------

function buildSummary({ first, newCampaigns, newCoupons }, now) {
  if (first) {
    return {
      headline: "首次采集完成，已建立基线。",
      items: [],
    };
  }
  const items = [];
  if (newCampaigns.length) {
    items.push({
      level: "new",
      text: `${newCampaigns.length} 个新活动：${newCampaigns.slice(0, 3).map((c) => c.title).join("、")}${newCampaigns.length > 3 ? " 等" : ""}`,
    });
  }
  if (newCoupons.length) {
    items.push({
      level: "new",
      text: `${newCoupons.length} 张新券：${newCoupons.slice(0, 3).map((c) => c.name).join("、")}${newCoupons.length > 3 ? " 等" : ""}`,
    });
  }
  return {
    headline: items.length ? "有变化" : "与上次一致",
    items,
  };
}

// --------------------------------------------------------------------------
// 工具
// --------------------------------------------------------------------------

function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round(v * f) / f;
}
