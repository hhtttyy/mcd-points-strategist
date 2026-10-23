# MCP_INTEGRATION.md

本文件说明本项目实际使用的麦当劳 MCP Server、Tool、调用流程与业务价值。

**MCP Server**：[M-China/mcd-mcp-server](https://github.com/M-China/mcd-mcp-server) ·
**接入地址**：`https://mcp.mcd.cn` · **协议**：Streamable HTTP · **认证**：`Authorization: Bearer <TOKEN>`
**MCP Server 版本**：v1.0.9（2026-09-10）· **采样时间**：2026-10-23 12:20 (GMT+8)

---

## 1. 使用的 Tool 清单

本项目调用 **8 个只读 Tool**，全部用于资产分析，不产生任何订单或消费。

| # | Tool | 名称 | 在本项目中的用途 |
|---|---|---|---|
| 1 | `now-time-info` | 获取当前时间信息 | 作为判断商城标的 `downTime` 是否已过的基准时间，避免用本地时钟误差误判上下架 |
| 2 | `query-my-account` | 我的积分查询 | 输入 `availablePoint` / `accumulativePoint` / `expiredPoint` / `usedPoint` / `currentMouthExpirePoint`，计算健康度四维与衰减率 |
| 3 | `mall-points-products` | 查询麦麦商城商品列表 | 提供兑换标的的 `point`（所需积分）、`spuName`（面值来源）、`downTime`（上下架）、`shopId`（兑换通道判定） |
| 4 | `query-lottery-info` | 查看积分抽奖活动信息 | 提供 `drawPoint`（单次消耗）与奖品列表，用于抽奖 vs 兑换的盈亏平衡分析 |
| 5 | `query-my-coupons` | 我的优惠券查询 | 识别已持有的券资产，纳入机会成本分析 |
| 6 | `available-coupons` | 麦麦省券列表查询 | 识别**零成本券**（免费/立减类），这类券不消耗积分，处置优先级最高 |
| 7 | `campaign-calendar` | 活动日历查询 | 发现积分加速购等时间窗（如「10:40 APP 专享积分抢先购」），用于攒分时机规划 |
| 8 | `order-list` | 查询历史订单 | 校准积分获取速率 `earnRate`（积分/元），用于补差金额估算 |

### 明确未调用的写操作 Tool

以下 Tool 会产生真实扣款或扣分，本项目**仅在用户明确要求时**经二次确认后调用：

`create-order`、`mall-create-order`、`draw-lottery`、`auto-bind-coupons`、
`party-order-create`、`cancel-order`、`delivery-create-address`

---

## 2. 关键字段与业务含义

### 2.1 面值必须从 `spuName` 解析（本项目踩过的坑）

`mall-points-products` 中，积分类标的（`point > 0`）的 **`price` 字段恒为 `0`**，
真实面值以中文数字形式写在 `spuName` 前缀中：

| spuName | point | price | 解析结果 |
|---|---|---|---|
| `6.9元可乐麦炫酷` | 50 | `0` | **¥6.9** |
| `21.9元巨无霸可乐组合` | 800 | `0` | **¥21.9** |
| `罗技键鼠套装` | 6666 | `0` | 无法解析（实物类，排除） |
| `麦当劳奇妙生日派对` | 0 | `50` | 现金类，不属于积分资产 |

若直接使用 `price` 字段，全部积分类标的密度将计算为 0，密度排名完全失真。
本项目在 `scripts/fetch-mcd-data.mjs` 的 `parseFaceValue()` 中按
`spuName 正则 → price 字段 → 0` 的优先级解析，并记录 `faceValueSource` 标注来源。

### 2.2 `downTime` 过期标的是必须过滤的陷阱

MCP 返回的商城列表**不自动过滤已下架标的**。2026-10-23 实测：
返回 50 件，其中在售且 `point > 0` 的仅 **7 件**，另有 **16 件**积分类标的 `downTime` 已过。
例如 `18.8元2份麦辣鸡翅`（200 分）实际已于 2026-03-21 下架 —— 用户若据此攒分则是纯浪费。

本项目在采集阶段即计算 `status`（`live` / `expired` / `upcoming`），
引擎中所有计算路径都强制过滤 `status !== 'live'`。

### 2.3 `shopId` 区分兑换通道

- `shopId = 2` → 积分兑换通道（`mall-create-order` 支持）
- `shopId = 5` → 派对预约通道（`party-order-create`，现金计费）

仅 `shopId = 2` 且 `point > 0` 的标的参与积分价值密度排名。

### 2.4 `query-lottery-info` 不暴露奖品概率分布

Tool 返回奖品名称、类型、图片，但**不含各奖品的概率**。
因此本项目**不计算期望值**（编造概率即造假），改为输出**盈亏平衡概率**：

```
p* = (redeemValue - worst) / (best - worst)
```

含义：只要「抽中最高价值奖品」的实际概率 > `p*`，抽奖就不劣于直接兑换。
这是可被读者独立验证的判断，而非黑箱数字。

---

## 3. 调用流程

```
now-time-info ──────────────┐
                            ↓
query-my-account ────┐   mall-points-products
        │            │         │  ├─ parseFaceValue(spuName) → faceValue
        │            │         │  ├─ status = downTime < now ? expired : live
        │            │         │  └─ filter: point>0 ∧ shopId=2 ∧ status=live
        │            │         ↓
        │            │   query-lottery-info
        │            │         │
        └────────────┴─────────┴──→ points-engine.mjs
                                       ├─ scoreHealth()        四维健康度
                                       ├─ rankByDensity()      密度排行
                                       ├─ detectDelistedTrap() 下架陷阱
                                       ├─ detectDeadlock()     门槛-余额死锁
                                       ├─ solveRedeemPlan()    0/1 背包
                                       ├─ compareLotteryVsRedeem() 盈亏平衡
                                       └─ buildActionPlan()    优先级动作清单
```

实现见 `scripts/fetch-mcd-data.mjs`（采集 + 脱敏）与 `scripts/points-engine.mjs`（纯函数计算）。

### 脱敏

采集结果落盘前剔除 `accountId`、`orderId`、`storeCode`、`beCode` 等标识字段，
仅保留算法所需的业务字段。`fixtures/mcd-snapshot.json` 为脱敏后快照，
可直接公开并同时作为在线 Demo 的数据源。

---

## 4. 业务价值

### 4.1 解决的问题

麦享会积分体系存在三处结构性 inefficiency，导致大量用户「攒了却没用」：

| 问题 | 机制 | 本项目的应对 |
|---|---|---|
| **边际收益率递减** | 50 分档密度 0.1380 元/分，800 分档仅 0.0274 元/分，相差 5.0 倍 | 密度排序 + 0/1 背包，避免「攒大件」的错误直觉 |
| **门槛-余额错配死锁** | 余额低于最低门槛时，换不到也过期 | 死锁检测 + 精确补差（算出最小消费额） |
| **下架陷阱** | 商城列表含 16 件已下架积分类标的 | 强制 `downTime` 过滤，防止为结束的活动攒分 |

### 4.2 真实用户案例（采样自 2026-10-23）

| 指标 | 数值 |
|---|---|
| 累计获得积分 | 1840 |
| 已过期积分 | 1100（**衰减率 59.8%**） |
| 当前可用 | 120 |
| 在售兑换门槛 | 最低 50 分 → **够不到任何标的** |
| 健康度评分 | **12 / 100（危险）** |

诊断结论：该用户处于典型的门槛-余额错配死锁 —— 33.5 分的余额与 50 分的门槛之间
只差 16.5 分（按 1 积分/元计，消费 ¥16.5 即可跨过）。
「继续攒」会让积分继续过期；正确解是**精确补差 + 优先消耗零成本券**。

### 4.3 与现有同类项目的差异

榜单前 10 名中 7 个属于「省钱 / 控卡 / 热量 / 人格 / 盲评」类目，同质化严重。
本项目切入的是**积分资产运营**方向，其数据链路（`query-my-account` + `mall-points-products` +
`query-lottery-info` + `available-coupons` + `campaign-calendar`）在榜单项目中几乎无人使用，
且存在可量化的算法产出（密度排序、背包最优解、帕累托前沿、盈亏平衡概率）。

---

## 5. 复现方式

```bash
# 1. 申请 Token：https://open.mcd.cn/mcp  → 控制台 → 激活
# 2. 配置 MCP 连接器（见 README）
# 3. 拉取实时数据并脱敏
MCP_TOKEN=<your_token> node scripts/fetch-mcd-data.mjs
# 4. 运行分析
node scripts/points-strategist.mjs
# 5. 算法自检（39 项断言）
node scripts/selftest.mjs
```

在线 Demo（零登录可玩）：<https://hhtttyy.github.io/mcd-points-strategist/>

---

*本项目为麦当劳程序员节创意开发大赛参赛作品，非麦当劳官方产品。*
