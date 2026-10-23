---
name: mcd-points-strategist
display_name: 麦麦积分资产管家
display_name_en: McDonald's Points Strategist
description: "麦当劳麦享会积分与优惠券资产运营助手。基于麦当劳中国 MCP Server 的积分账户、积分商城、抽奖、三路优惠券（麦麦省可领/卡包持有/门店专属）、活动日历、门店促销与历史订单数据，做四维健康度诊断（存活率/变现率/效率/临期安全度）、积分价值密度排名（元/积分）与门槛-余额死锁检测、0/1 背包最优兑换组合与帕累托前沿、券的 5 类建模与保守叠加求解、券沉默成本与「真正可用天数」判定、用券排程（二分图最大匹配）、积分影子价格驱动的积分×券联合决策，以及每日巡检的昨日今日增量（自动发现新活动/新券/新订单/临期资产）。用户提到麦当劳积分、麦享会、积分过期、积分兑换、积分商城、积分抽奖、巨无霸兑换券、麦麦省优惠券、麦当劳省钱、今天有什么优惠、这家店怎么样、我的积分有多少、积分能换什么、积分怎么用划算、我的券快过期了、这些券该怎么用时触发。"
description_zh: "把麦当劳积分与优惠券当资产管理。基于 MCP 实时数据做四维健康度诊断、积分价值密度排名、门槛-余额死锁检测、0/1 背包最优兑换求解与帕累托前沿、券的 5 类建模与保守叠加求解、券沉默成本与可用时段判定、用券排程（二分图最大匹配）、积分影子价格驱动的积分×券联合决策，以及每日巡检增量。输出按「零成本→有成本」排序的行动清单。所有结论基于真实数据，不做无依据的期望值估计。"
description_en: "Treat McDonald's loyalty points and coupons as an asset portfolio. Live MCP data drives four-dimension health scoring, points-value-density ranking, threshold-balance deadlock diagnosis, 0/1 knapsack redemption with Pareto frontier, five-type coupon modelling with conservative stacking, coupon silent-cost and true-usable-day computation, bipartite-matching coupon scheduling, and a points-shadow-price engine that lets points and coupons compete on one scale. Includes daily patrol with snapshot diffing. All conclusions are data-grounded; no fabricated expected values."
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
| `query-my-coupons` | 已持有的券（**唯一能拿到券有效期与限制的来源**） | ✅ |
| `available-coupons` | 可领取的零成本券（**账户全域，与门店无关**） | ✅ |
| `campaign-calendar` | 活动日历（必传 `specifiedDate`） | 建议 |
| `query-store-coupons` | 门店专属券（需 `storeCode`） | 查门店时 |
| `query-promotions` | 门店级促销（需 `storeCode`，**未在官方文档中**） | 查门店时 |
| `query-nearby-stores` | 定位门店拿 `storeCode`（必传 `beType`+`searchType`） | 查门店时 |
| `order-list` | 历史订单（识别新下单、校准 earnRate） | 建议 |
| `now-time-info` | 服务器当前时间（判断上下架的基准） | ✅ |

> ⚠️ **不要调用** `create-order`、`mall-create-order`、`draw-lottery`、`auto-bind-coupons`、
> `party-order-create` 等产生消费的写操作，除非用户明确要求并二次确认。

> ⚠️ **券必须三路查全**：`available-coupons`（账户全域可领）/ `query-my-coupons`（卡包持有，
> 含有效期）/ `query-store-coupons`（门店可用）。实测同一用户卡包 9 张、该门店只认 2 张 ——
> 只查一路会漏掉最优组合，也会漏算沉默成本。

### Step 3 · 运行分析引擎

```bash
# 采集 + 巡检（会落盘到 data/，已 gitignore）
MCD_MCP_TOKEN=<token> node scripts/app/patrol.mjs            # 巡检 + 与上次对比
MCD_MCP_TOKEN=<token> node scripts/app/patrol.mjs --claim    # 同时执行一键领券（需确认）

# 看板（只读快照，无网络）
node scripts/app/dashboard.mjs                # 对话内看板
node scripts/app/dashboard.mjs --channel pickup --hour 18
node scripts/app/dashboard.mjs --full         # 完整巡检报告

# 券专项
node scripts/app/coupon-report.mjs            # 券体检 + 沉默成本 + 用券排程

# 积分侧分析
node scripts/points-strategist.mjs            # 完整报告
node scripts/points-strategist.mjs --budget 800  # 假设积分余额
node scripts/points-strategist.mjs --json       # 结构化输出

# 自检
node scripts/selftest.mjs               # 算法层 39 项
node scripts/app/selftest-collect.mjs   # 采集层 65 项
node scripts/app/selftest-coupon.mjs     # 券引擎 69 项
node scripts/app/selftest-patrol.mjs     # 巡检与联合决策 38 项
```

**分层约束**（本项目架构的核心纪律）：

```
app/     → 唯一允许 IO（发网络请求、读写文件）的层
analyze/ → 纯函数：(输入JSON) => (输出JSON)
collect/ → 纯函数：MCP 原始响应 => 契约对象
lib/     → 协议与数据契约
```

依赖方向严格单向 `app → analyze → collect → lib`。**不要在 analyze/ 里写 IO。**

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

**涉及券时，额外必须说明**：

- 券的**真正可用天数**（不是剩余日历天数）—— 券常带星期与时段限制
- **沉默成本**：手里 N 张券将在 X 天内过期，未用则白扔 ¥Y
- 券的**等值积分**（按影子价格折算）—— 让积分与券能直接比大小

**用户问「今天有什么优惠 / 这家店怎么样」时**：

1. 先 `auto-bind-coupons` 领券（**账户全域，与门店无关，可先做**）
2. 再 `query-nearby-stores` 定位门店 → `query-store-coupons` + `query-promotions` 核对该店
3. 结合积分给出方案

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
- **单位方向相反**：`order-list` 的 `realTotalAmount` 已是**元**，`calculate-price`/`mall-*` 是**分**。
  误换算会让消费画像缩小 100 倍。
- **不拿营销文案算钱**：活动日历与 `mall-product-detail` 的 `note` 里的价格不可核实，一律丢弃。
- **不把「有活动」说成「更便宜」** —— 那是两回事。
  只能给出价值区间与盈亏平衡概率（见 `references/algorithm.md`）。

## 参考文档

- `references/algorithm.md` —— 算法公式与推导（健康度权重、密度、死锁、背包、盈亏平衡）
- `references/mcp-tools.md` —— 麦当劳 MCP 工具清单与字段说明
- `references/playbook.md` —— 常见场景处置话术
- `fixtures/mcd-snapshot.json` —— 脱敏示例数据（2026-10-23 采集）
- 在线 Demo：<https://hhtttyy.github.io/mcd-points-strategist/>

## 免责声明

本 skill 为非麦当劳官方产品。输出仅供参考，不构成财务或消费建议。
积分与商品数据以麦当劳官方渠道实时结果为准，实际兑换请在麦麦商城/App 内操作。
