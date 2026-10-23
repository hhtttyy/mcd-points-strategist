/**
 * mcd-points-strategist · 账本与复盘
 *
 * 闭环的最后一环：**用真实数据回校参数，让下次决策更准。**
 *
 * 为什么需要账本：MCP 给的是「现在的状态」，但决策依赖「历史的关系」。
 * 比如 earnRate（1 积分值多少元）—— 没有历史数据就只能用默认值 1.0，
 * 而默认值错了，补差金额就会算错。
 *
 * 关键约束：`order-list` **不返回每单获得的积分**（实测字段里没有 earnPoint），
 * 所以 earnRate 只能从**账户积分增量**反推：
 *
 * ```
 * earnRate = (本次累计积分 - 上次累计积分) / (期间有效消费金额)
 * ```
 *
 * 这个口径比「默认 1.0」可靠得多 —— 它包含了活动加速、会员等级加成等所有因素。
 *
 * 本模块是纯函数，不碰 IO。
 */

// --------------------------------------------------------------------------
// 账本记录
// --------------------------------------------------------------------------

/**
 * 一条账本记录的结构。
 *
 * @typedef {object} LedgerRecord
 * @property {string} ts            记录时间 ISO
 * @property {string} action        动作类型：claim / redeem / draw / order
 * @property {string} [target]      动作对象（券名 / 商品名 / 奖品名）
 * @property {number} [costPoints]  消耗积分
 * @property {number} [costYuan]    消耗金额
 * @property {number} [gainYuan]    预期收益
 * @property {string} [note]        备注
 * @property {object} [meta]        附加信息
 */

/**
 * 构造一条账本记录。
 */
export function makeRecord(action, fields = {}) {
  return {
    ts: fields.ts || new Date().toISOString(),
    action,
    target: fields.target ?? null,
    costPoints: num(fields.costPoints),
    costYuan: num(fields.costYuan),
    gainYuan: num(fields.gainYuan),
    note: fields.note ?? "",
    meta: fields.meta ?? {},
  };
}

/**
 * 把账本记录转成 CSV（便于人工查看与外部工具处理）。
 */
export function toCsv(records = []) {
  if (!records.length) return "";
  const cols = ["ts", "action", "target", "costPoints", "costYuan", "gainYuan", "note"];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of records) {
    lines.push(cols.map((c) => esc(r[c])).join(","));
  }
  return lines.join("\n");
}

/**
 * 解析账本（JSONL 格式，一行一条）。
 *
 * 坏行跳过而不整体失败 —— 账本可能被手工编辑过。
 */
export function parseLedger(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.action) out.push(o);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// earnRate 校准
// --------------------------------------------------------------------------

/**
 * 从两次账户快照反推 earnRate。
 *
 * ```
 * earnRate = Δ累计积分 / 期间有效消费金额
 * ```
 *
 * 「有效消费金额」要排除两类订单：
 *   - **整单退款** —— 钱退了，积分通常也退，这不是消费
 *   - **0 元订单** —— 券核销 / 积分兑换，不是新的消费
 *
 * ⚠️ 部分退款的金额接口不给退款额，所以**部分退款仍全额计入**，
 *    这会让 earnRate 略微偏高 —— 如实说明，不假装精确。
 *
 * @param {object} prevAccount 上次账户快照
 * @param {object} currAccount 本次账户快照
 * @param {Array}  orders       本期间的订单
 * @returns {{earnRate, pointsDelta, spend, sampleSize, confidence, note}}
 */
export function calibrateEarnRate(prevAccount, currAccount, orders = []) {
  // 没有上一次账户快照 → 无法算增量，直接放弃校准。
  // ⚠️ 不能把缺失的 prev 当作 0 —— 那会把「累计获得 581 分」误当成
  //    「本期赚了 581 分」，earnRate 直接算成 9.79 这种荒谬值。
  //    判断依据是**字段是否存在**，不是值是否为 0（0 是合法的基线）。
  const hasPrev =
    prevAccount && prevAccount.accumulative !== undefined && prevAccount.accumulative !== null;
  if (!hasPrev) {
    return {
      earnRate: null,
      pointsDelta: 0,
      spend: round(sumEligibleSpend(orders)),
      sampleSize: orders.length,
      confidence: "insufficient",
      note: "缺少上一次账户快照，无法计算积分增量 —— 跑两次巡检后即可校准",
    };
  }

  const pointsDelta = num(currAccount?.accumulative) - num(prevAccount?.accumulative);
  const spend = sumEligibleSpend(orders);

  if (pointsDelta <= 0 || spend <= 0) {
    return {
      earnRate: null,
      pointsDelta,
      spend: round(spend),
      sampleSize: orders.length,
      confidence: "insufficient",
      note:
        pointsDelta <= 0
          ? "累计积分没有增加，无法反推 earnRate"
          : "期间没有有效消费金额，无法反推 earnRate",
    };
  }

  const earnRate = pointsDelta / spend;
  // 样本太小时置信度低 —— 一个订单不足以校准
  const confidence = orders.length >= 5 ? "high" : orders.length >= 2 ? "medium" : "low";

  return {
    earnRate: round(earnRate, 4),
    pointsDelta: round(pointsDelta),
    spend: round(spend),
    sampleSize: orders.length,
    confidence,
    note: `本次累计积分 +${round(pointsDelta)}，期间有效消费 ¥${round(spend)}`,
  };
}

/**
 * 计算有效消费金额。
 *
 * 排除整单退款与 0 元订单；部分退款仍计入（接口不给退款额）。
 */
export function sumEligibleSpend(orders = []) {
  let sum = 0;
  for (const o of orders) {
    const status = String(o.status || "");
    const amount = num(o.amount);
    if (status.includes("整单退款")) continue; // 全退，不是消费
    if (amount <= 0) continue; // 0 元订单（券核销/积分兑换）
    sum += amount;
  }
  return sum;
}

/**
 * 用校准后的 earnRate 修正补差规划。
 *
 * 默认 earnRate=1.0 时，凑 50 分要消费 ¥16.5；
 * 若实际 earnRate 是 1.2，同样 16.5 分只要消费 ¥13.75 —— 省 ¥2.75。
 */
export function refineTopUp(target, available, earnRate = 1) {
  const gap = round(Math.max(0, num(target?.point) - num(available)));
  const rate = num(earnRate) || 1;
  const spendNeeded = round(gap / rate);
  return {
    gap,
    earnRate: rate,
    spendNeeded,
    note: `还差 ${gap} 分，按 ${rate} 积分/元需消费约 ¥${spendNeeded}`,
  };
}

// --------------------------------------------------------------------------
// 复盘
// --------------------------------------------------------------------------

/**
 * 复盘账本 —— 把「当初说的」和「实际发生的」对起来。
 *
 * 对三类资产分别复盘：
 *   1. **积分**：预测的兑换收益 vs 实际
 *   2. **券**：预测的面值 vs 实际核销省下的钱
 *   3. **抽奖**：预测的盈亏平衡点 vs 实际回报
 *
 * @param {Array} records 账本记录
 * @param {object} opts
 * @param {object} [opts.currentAccount] 当前账户（用于算实际余额变化）
 * @param {object} [opts.prevAccount]   上次账户
 * @param {Array}  [opts.orders]        本期订单
 */
export function reviewLedger(records = [], opts = {}) {
  const list = (records || []).filter(Boolean);

  const byAction = {};
  for (const r of list) {
    byAction[r.action] = (byAction[r.action] || 0) + 1;
  }

  // 积分支出与预期收益
  const pointsSpent = round(list.reduce((s, r) => s + num(r.costPoints), 0));
  const yuanGained = round(list.reduce((s, r) => s + num(r.gainYuan), 0));

  // earnRate 校准
  const calibration = calibrateEarnRate(
    opts.prevAccount,
    opts.currentAccount,
    opts.orders || []
  );

  // 偏差分析：预期 vs 实际
  const deviations = [];
  if (calibration.earnRate && opts.defaultEarnRate) {
    const diff = round(calibration.earnRate - opts.defaultEarnRate);
    if (Math.abs(diff) >= 0.05) {
      deviations.push({
        kind: "earnRate",
        text:
          `earnRate 实际 ${calibration.earnRate}，默认假设 ${opts.defaultEarnRate}，` +
          `偏差 ${diff > 0 ? "+" : ""}${diff} —— 补差金额需要按实际值修正`,
        impact: diff > 0 ? "攒分比预想的快，补差花的钱更少" : "攒分比预想的慢，补差要花更多钱",
      });
    }
  }

  const lotteryRecords = list.filter((r) => r.action === "draw");
  if (lotteryRecords.length) {
    const spent = round(lotteryRecords.reduce((s, r) => s + num(r.costPoints), 0));
    const got = round(lotteryRecords.reduce((s, r) => s + num(r.gainYuan), 0));
    const roi = spent > 0 ? round(got / spent, 3) : null;
    deviations.push({
      kind: "lottery",
      text: `抽奖 ${lotteryRecords.length} 次，消耗 ${spent} 积分，实得约 ¥${got}`,
      impact: roi !== null ? `每积分回报 ¥${roi}，对照兑换密度可判断抽奖是否划算` : "",
    });
  }

  return {
    recordCount: list.length,
    byAction,
    pointsSpent,
    yuanGained,
    calibration,
    deviations,
    narrative: buildReviewNarrative({ list, pointsSpent, yuanGained, calibration, deviations }),
  };
}

function buildReviewNarrative({ list, pointsSpent, yuanGained, calibration, deviations }) {
  if (!list.length) {
    return "账本还是空的 —— 执行一次动作（领券/兑换/抽奖）后，这里会开始积累复盘数据。";
  }
  const parts = [`账本有 ${list.length} 条记录`];
  if (pointsSpent > 0) parts.push(`累计支出 ${pointsSpent} 积分`);
  if (yuanGained > 0) parts.push(`预期收益 ¥${yuanGained}`);
  if (calibration.earnRate) {
    parts.push(`实测 earnRate ${calibration.earnRate} 积分/元`);
  }
  let text = `${parts.join("，")}。`;
  if (deviations.length) {
    text += `其中 ${deviations.length} 处与原先假设有偏差，已用于修正下次决策。`;
  }
  return text;
}

// --------------------------------------------------------------------------
// 工具
// --------------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round((v ?? 0) * f) / f;
}
