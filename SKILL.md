---
name: mcd-points-strategist
display_name: 麦麦积分资产管家
display_name_en: McDonald's Points Strategist
description: "麦当劳麦享会积分资产运营助手。解决一个真实痛点：积分攒了不用、到期清零、兑换档位越攒越亏。基于麦当劳中国 MCP Server 的积分账户、积分商城、抽奖、优惠券、活动日历数据，诊断积分健康度（存活率/变现率/效率/临期安全度），计算每件兑换标的的积分价值密度（元/积分），识别「边际收益率递减」与「门槛-余额错配死锁」，用 0/1 背包求解最优兑换组合并给出帕累托前沿，最终输出按优先级排序的处置动作（先领零成本券 → 避开已下架标的 → 补差解锁高ROI档位 → 抽奖 → 兑换）。用户提到麦当劳积分、麦享会、积分过期、积分兑换、积分商城、积分抽奖、巨无霸兑换券、麦麦省优惠券、麦当劳省钱、我的积分有多少、积分能换什么、积分怎么用划算时触发。"
description_zh: "把麦当劳积分当资产管理。基于 MCP 实时数据做四维健康度诊断、兑换标的积分价值密度排名、边际收益率递减识别、门槛-余额错配死锁检测、0/1 背包最优兑换组合求解与帕累托前沿，输出按优先级排序的处置动作清单。所有结论基于真实数据，不做无依据的期望值估计。"
description_en: "Treat McDonald's loyalty points as an asset. Uses live MCP data for four-dimension health scoring, points-value-density ranking, diminishing-returns detection, threshold-balance deadlock diagnosis, 0/1 knapsack optimal redemption solving with Pareto frontier, and a priority-ordered action list. All conclusions are data-grounded; no fabricated expected values."
category: finance
version: 1.0.0
author: hantianyi
agent_created: true
---

# 麦麦积分资产管家 · mcd-points-strategist

## 何时使用

用户提到以下任一情况时使用本 skill：

- 「我有多少麦当劳积分」「积分怎么过期了」「积分能换什么」
- 「积分兑换哪个划算」「积分怎么用最值」「积分商城哪个性价比高」
- 「积分抽奖值不值」「要不要抽奖」
- 「麦当劳省钱」「麦麦省优惠券」「巨无霸兑换券」
- 「帮我管一下积分」「积分规划」「积分怎么攒」
- 用户想查询麦当劳活动日历、可用优惠券、订单历史等积分周边数据

**不适用**：直接点餐下单（用麦当劳 MCP 原生工具即可，无需本 skill）。

## 核心问题：积分不是攒出来的，是漏掉的

麦享会积分体系存在三处结构性 inefficiency，本 skill 的全部算法都围绕它们展开：

### 1. 边际收益率递减 —— 攒得越多，换得越亏

积分商城的兑换档位不是等价的。实测（2026-10）在售兑换标的面值密度：

| 档位 | 兑换品 | 面值 | 密度（元/积分） |
|---|---|---|---|
| 50 分 | 6.9元可乐麦炫酷 / 香芋派任选 | ¥6.9 | **0.1380** |
| 100 分 | 10.9元指定小食任选 | ¥10.9 | 0.1090 |
| 200 分 | 10.9元指定小食任选 | ¥10.9 | 0.0545 |
| 500 分 | 17.9元板烧可乐组合 | ¥17.9 | 0.0358 |
| 800 分 | 21.9元巨无霸可乐组合 | ¥21.9 | **0.0274** |

**最优档与最差档相差 5 倍。** 「攒够 800 分换巨无霸」是最差决策——为 21.9 元商品付出 800 分，
而同样的 800 分可以换 16 件 6.9 元券（面值 110.4 元）。**用 0/1 背包求解而非贪心，是本 skill 的核心。**

### 2. 门槛-余额错配死锁 —— 够不着，也过不了期

当可用积分低于所有高 ROI 档位的最低门槛时，用户进入死锁：换不到划算的东西，积分却按期清零。
实测案例：可用 33.5 分，最低门槛 50 分，缺口 16.5 分——此时最优解不是「继续攒」，
而是**精确补差**（消费 ¥16.5 解锁 50 分档），或转用抽奖 / 零成本券。

### 3. 下架陷阱 —— 商城列表不自动过滤过期标的

`mall-points-products` 返回的 50 件标的中，**16 件积分标的的 `downTime` 已过**（2026-10 实测）。
例如「18.8元2份麦辣鸡翅」需 200 分，但活动 2026-03-21 就结束了。
不剔除这些，用户会为早已结束的活动白攒积分。**本 skill 强制做上下架过滤。**

## 工作流程

### Step 1 · 确认 MCP 连接

本 skill 依赖麦当劳中国 MCP Server（`https://mcp.mcd.cn`，Streamable HTTP + Bearer Token）。

检查连接器 `mcd-mcp` 是否已启用；未启用时引导用户：
1. 到 [open.mcd.cn/mcp](https://open.mcd.cn/mcp) 手机号登录 → 控制台 → 激活 → 复制 Token
2. 在 WorkBuddy 左侧【专家·技能·连接器】→【自定义连接器】→【配置MCP】，填入：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

### Step 2 · 拉取数据

按需调用以下 MCP 工具（**只读工具，不产生订单/消费**）：

| 工具 | 用途 | 是否必需 |
|---|---|---|
| `query-my-account` | 积分账户（可用/累计/已用/已过期/临期） | ✅ |
| `mall-points-products` | 积分商城标的（含 `point`/`downTime`） | ✅ |
| `query-lottery-info` | 抽奖活动（单次消耗、奖品列表） | ✅ |
| `query-my-coupons` | 已持有的券 | 建议 |
| `available-coupons` | 可领取的零成本券 | 建议 |
| `campaign-calendar` | 活动日历（含积分加速活动） | 建议 |
| `order-list` | 历史订单（用于校准积分获取速率） | 可选 |
| `now-time-info` | 服务器当前时间（判断上下架的基准） | ✅ |

> ⚠️ **不要调用** `create-order`、`mall-create-order`、`draw-lottery`、`auto-bind-coupons`、
> `party-order-create` 等产生消费的写操作，除非用户明确要求并二次确认。

### Step 3 · 运行分析引擎

```bash
# 用真实 MCP 数据生成快照（会脱敏）
MCP_TOKEN=<token> node scripts/fetch-mcd-data.mjs

# 分析
node scripts/points-strategist.mjs            # 完整报告
node scripts/points-strategist.mjs --budget 800  # 假设积分余额
node scripts/points-strategist.mjs --json       # 结构化输出
node scripts/selftest.mjs                     # 算法自检（39 项）
```

`scripts/points-engine.mjs` 是零依赖纯函数库，浏览器 Demo 复用同一份实现，
保证 CLI 与网页结论完全一致。

### Step 4 · 输出结论

**必须包含这五部分**，顺序不可变：

1. **一句话诊断** —— 例如「你有 763 累计积分，可用 33.5 分，已过期 729.5 分（衰减率 95.6%），
   且当前余额够不到任何在售兑换档位（最低 50 分），正处于门槛-余额错配死锁。」
2. **健康度评分** —— 0-100 分 + 四维拆解（存活率 40% / 变现率 25% / 效率 25% / 临期安全度 10%）
3. **兑换档位密度排行** —— 在售标的按元/积分排序，标出最优档与边际递减倍数
4. **死锁诊断** —— 若死锁，给出精确补差金额（¥）与目标档位
5. **行动清单** —— 按优先级排序，每条含动作、成本、理由

### Step 5 · 引导执行（需确认）

- 领券：`auto-bind-coupons` —— 零成本，优先执行
- 抽奖：`draw-lottery` —— 会扣积分，**执行前必须告知单次消耗与剩余次数**
- 兑换：`mall-create-order` —— 每件商品单独成单，**执行前必须列出清单与总价并二次确认**

## 关键约束

- **面价必须从 `spuName` 解析**：积分类标的的 `price` 字段恒为 `0`，
  真实面值在名称前缀（如「18.8元2份麦辣鸡翅」→ 18.8）。用 `price` 会算出密度全为 0 的错误结论。
- **必须过滤 `status !== 'live'`**：`downTime < now` 的标的一律排除。
- **每件商品单独成单**：`mall-create-order` 要求单个商品一个订单，多件兑换需分别下单。
- **仅 `shopId=2` 支持积分兑换**：`shopId=5` 是派对预约通道（现金）。
- **抽奖不含概率**：`query-lottery-info` 不暴露奖品概率分布，**禁止编造期望值**。
  只能给出价值区间与盈亏平衡概率（见 `references/algorithm.md`）。

## 参考文档

- `references/algorithm.md` —— 算法公式与推导（健康度权重、密度、死锁、背包、盈亏平衡）
- `references/mcp-tools.md` —— 麦当劳 MCP 工具清单与字段说明
- `references/playbook.md` —— 常见场景处置话术
- `fixtures/mcd-snapshot.json` —— 脱敏示例数据（2026-10-23 采集）
- 在线 Demo：<https://hantianyi.github.io/mcd-points-strategist/>

## 免责声明

本 skill 为非麦当劳官方产品。输出仅供参考，不构成财务或消费建议。
积分与商品数据以麦当劳官方渠道实时结果为准，实际兑换请在麦麦商城/App 内操作。
