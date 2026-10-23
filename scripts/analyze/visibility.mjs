/**
 * mcd-points-strategist · App 可见性诊断
 *
 * 回答一个具体问题：**为什么我在麦当劳 App 里看不到这张券？**
 *
 * 背景（2026-10-23 实测）：
 *   用户 App 卡包只显示 2 张券，而 MCP `query-my-coupons` 返回 5 张。
 *   逐字段对比后找到三个判别依据：
 *
 *   ① **receiveTime（领取时刻）** —— 决定性证据
 *      App 里显示的券，其 receiveTime 早于本次自动领券的时刻；
 *      刚领的那几张 receiveTime 恰好等于 `auto-bind-coupons` 的 datetime。
 *      → 说明「App 看不到」是**同步延迟**，不是券不存在。
 *
 *   ② **serverTags** —— 服务端给的分组标签
 *      带 `{type:3, value:"due today", label:"今日到期"}` 的券，
 *      在 App 里可能被归到「即将过期」分区而非卡包列表顶部。
 *
 *   ③ **orderTypes / channels** —— 适用场景
 *      `orderTypes:[1,2]` = 到店+外送通用；`[1]` = 仅到店。
 *      `channels` 的具体编码官方未说明，但**两组券的取值集合不同**，
 *      可作为「这张券是不是限定在某个场景」的判别依据。
 *
 * ⚠️ 本模块**不猜测** App 的具体渲染逻辑（那是 App 客户端的事，接口不暴露）。
 *    它只输出**可验证的事实**：领取时刻、服务端标签、适用场景、可用性判定。
 *    结论措辞是「这些事实指向什么」，而不是「App 一定是因为 X」。
 *
 * 本模块是纯函数，不碰 IO。
 */

/** 星期名（0=周日） */
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** beType → 场景名 */
const BE_TYPE_NAMES = {
  1: "到店自取",
  2: "麦乐送",
  5: "得来速",
  6: "团餐",
};

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * 诊断单张券的 App 可见性线索。
 *
 * @param {object} coupon        券（已采集，含 receiveTime / serverTags）
 * @param {object} opts
 * @param {string} [opts.claimAt] 本次自动领券的 ISO 时刻（auto-bind-coupons 的 datetime）
 * @param {Date}   [opts.now]
 * @param {number} [opts.hour]
 * @param {string} [opts.channel]
 */
export function diagnoseVisibility(coupon, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const c = coupon || {};
  const facts = [];

  // ---- 事实 1：领取时刻 ----
  const receivedAt = c.receivedAt ? new Date(c.receivedAt) : null;
  const claimAt = opts.claimAt ? new Date(opts.claimAt) : null;
  const justClaimed =
    receivedAt && claimAt
      ? Math.abs(receivedAt.getTime() - claimAt.getTime()) < 5 * 60 * 1000 // 5 分钟内
      : false;
  if (receivedAt) {
    facts.push({
      kind: "received_at",
      label: "领取时刻",
      value: c.receivedText || receivedAt.toISOString(),
    });
  }
  if (justClaimed) {
    facts.push({
      kind: "just_claimed",
      label: "同步状态",
      value: "刚领取（与本次自动领券同一时刻）",
      hint: "券已到账，若 App 里看不到，多半是客户端同步延迟 —— 下拉刷新或重新进入卡包即可",
    });
  }

  // ---- 事实 2：服务端标签 ----
  const tags = c.serverTags || [];
  const dueToday = tags.find((t) => t.value === "due today" || t.label === "今日到期");
  if (dueToday) {
    facts.push({
      kind: "due_today",
      label: "服务端标签",
      value: dueToday.label || "今日到期",
      hint: "服务端把它标为「今日到期」—— App 很可能归到「即将过期」分区，而不是卡包首屏",
    });
  }
  const channelTags = tags.filter((t) => t.type === 2);
  if (channelTags.length) {
    facts.push({
      kind: "channels_tag",
      label: "适用场景",
      value: channelTags.map((t) => t.label || t.value).join("、"),
    });
  }

  // ---- 事实 3：适用订单类型 ----
  const orderTypes = c.orderTypes || [];
  if (orderTypes.length) {
    const names = orderTypes
      .map((t) => (t === 1 ? "到店" : t === 2 ? "外送" : `orderType${t}`))
      .join("+");
    facts.push({
      kind: "order_types",
      label: "适用订单类型",
      value: names,
      hint:
        orderTypes.length > 1
          ? "到店与外送都能用 —— 若 App 停在「到店」视图，可能没在这个视图里显示"
          : "仅到店可用",
    });
  }

  // ---- 事实 4：当前是否可用 ----
  const weekdays = c.weekdays || [];
  const dow = now.getDay();
  const wdOk = !weekdays.length || weekdays.includes(dow);
  const inPeriod = !c.expireAt || new Date(c.expireAt) >= now;
  const inFrom = !c.validFrom || new Date(c.validFrom) <= now;
  const nowUsable = wdOk && inPeriod && inFrom;

  // ---- 结论 ----
  let conclusion;
  let confidence;
  if (justClaimed) {
    conclusion = "券已到账（领取时刻与本次自动领券一致），App 侧大概率是同步延迟";
    confidence = "high";
  } else if (dueToday && !wdOk) {
    conclusion = `券限${c.weekdayText || "特定星期"}使用，今天是${WD[dow]} —— 今天本来就用不了，App 不显示属于正常`;
    confidence = "high";
  } else if (dueToday) {
    conclusion = "服务端标为「今日到期」—— App 可能归到「即将过期」分区而非卡包首屏";
    confidence = "medium";
  } else if (!nowUsable) {
    conclusion = `券当前不可用（${!inFrom ? "尚未生效" : !inPeriod ? "已过期" : `限${c.weekdayText || "特定星期"}`}）`;
    confidence = "high";
  } else {
    conclusion = "券当前可用且早已在卡包 —— App 未显示需要向麦当劳官方确认";
    confidence = "low";
  }

  return {
    name: c.name,
    couponId: c.id,
    facts,
    nowUsable,
    conclusion,
    confidence,
  };
}

/**
 * 批量诊断，并给出一句总述。
 *
 * @param {Array}  coupons
 * @param {object} opts
 * @param {string} [opts.claimAt] 本次自动领券时刻
 * @param {Array}  [opts.appVisibleIds] 用户在 App 里能看到的券 ID（可选，用于对比）
 */
export function diagnoseVisibilityBatch(coupons = [], opts = {}) {
  const list = (coupons || []).filter(Boolean);
  const results = list.map((c) => diagnoseVisibility(c, opts));

  const appIds = new Set(opts.appVisibleIds || []);
  const hasAppList = appIds.size > 0;

  let summary;
  if (!hasAppList) {
    const justClaimed = results.filter((r) => r.facts.some((f) => f.kind === "just_claimed")).length;
    summary =
      justClaimed > 0
        ? `其中 ${justClaimed} 张是刚领取的（领取时刻与本次自动领券一致）—— App 侧大概率尚未同步`
        : "未提供 App 可见列表，无法逐张比对；下拉刷新 App 卡包后再比对";
  } else {
    const visible = results.filter((r) => appIds.has(r.couponId));
    const invisible = results.filter((r) => !appIds.has(r.couponId));
    const justClaimed = invisible.filter((r) =>
      r.facts.some((f) => f.kind === "just_claimed")
    ).length;
    summary =
      `App 能看到 ${visible.length} 张、看不到 ${invisible.length} 张` +
      (justClaimed > 0
        ? `；看不到的里有 ${justClaimed} 张是刚领取的 —— 大概率是同步延迟`
        : `；看不到的都已在卡包中（领取于更早），需向官方确认`);
  }

  return { results, summary, hasAppList };
}

/**
 * 把诊断结论渲染成给人看的一段话。
 */
export function renderVisibilityReport(batch, opts = {}) {
  const L = [];
  L.push("📱 **App 可见性诊断**");
  L.push("");
  L.push(`  ${batch.summary}`);
  L.push("");
  for (const r of batch.results) {
    L.push(`  ▸ ${r.name}`);
    for (const f of r.facts) {
      L.push(`      ${f.label}：${f.value}`);
      if (f.hint) L.push(`        → ${f.hint}`);
    }
    L.push(`      结论：${r.conclusion}（置信度 ${r.confidence}）`);
  }
  if (opts.footnote) {
    L.push("");
    L.push(`  ${opts.footnote}`);
  }
  return L.join("\n");
}
