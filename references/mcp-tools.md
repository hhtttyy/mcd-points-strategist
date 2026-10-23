# 麦当劳 MCP 工具参考

数据源：[M-China/mcd-mcp-server](https://github.com/M-China/mcd-mcp-server) ·
服务地址 `https://mcp.mcd.cn` · 协议 Streamable HTTP · 认证 `Authorization: Bearer <TOKEN>` · 限流 600 次/分钟

本 skill 使用其中 **8 个只读工具**。

---

## 只读工具（本 skill 使用）

### `query-my-account` —— 积分账户

返回 `data`：

| 字段 | 说明 |
|---|---|
| `availablePoint` | 可用积分（**核心输入**） |
| `accumulativePoint` | 累计获得积分 |
| `usedPoint` | 已使用积分 |
| `expiredPoint` | 已过期积分 |
| `frozenPoint` | 冻结积分 |
| `currentMouthExpirePoint` | 本月将过期积分 |
| `nextMouthExpirePoint` | 下月将过期积分 |
| `currency` | 货币类型（麦享会积分） |

> 实测样例：`availablePoint=33.5, accumulativePoint=763, expiredPoint=729.5, usedPoint=0`
> → 衰减率 95.6%，可用余额 4.4%。

### `mall-points-products` —— 积分商城

返回 `data[]`，每件：

| 字段 | 说明 | 陷阱 |
|---|---|---|
| `spuId` | 商品 ID | — |
| `spuName` | 商品名 | **面值藏在这里**，如「18.8元2份麦辣鸡翅」 |
| `point` | 所需积分 | `0` = 现金购买，不属于积分资产 |
| `price` | 现金价 | **积分类恒为 0**，不可用作面值 |
| `catName` | 类目 | 到店专用 / 生日类派对 / 主题类派对 / 品鉴会 / 读书会 / 玩具 / 鞋袜 |
| `shopId` | 店铺 ID | `2` = 积分兑换通道；`5` = 派对预约通道（现金） |
| `upTime` / `downTime` | 上下架时间 | **`downTime` 已过的标的是陷阱**，必须过滤 |
| `selling` | 描述文案 | 面值解析的备用来源 |
| `status` | 状态 | `2` = 在售 |

> 实测（2026-10-23）：共返回 50 件，其中在售且 `point>0` 的仅 **7 件**，
> 另有 **16 件**积分类标的 `downTime` 已过期。

### `query-lottery-info` —— 积分抽奖

返回 `data`：活动名/状态、`drawPoint`（单次消耗积分）、`drawTypeText`、
`availableTimes`、`availablePoint`、`drawDecision`（服务端计算的资源决策）、
`prizes[]`（奖品名 + 类型 + 图片）。

> **不返回奖品概率分布** —— 禁止编造期望值。

### `query-my-coupons` —— 已持有券

返回用户卡包中的券资产。**注意**：该接口不做门店/渠道/配送方式的下单规则校验，
不承诺可用于当前订单。要判断「当前门店可用券」应改用 `query-store-coupons`。

### `available-coupons` —— 可领取券

返回麦麦省券列表（标题 + 图片 + 状态 + 促销标签），Markdown 格式文本。
用于识别**零成本券**（免费/立减/买1送1），这类券不消耗积分，优先级最高。

### `campaign-calendar` —— 活动日历

返回当月营销活动（进行中 / 往期 / 未来），含积分加速购等信息的描述文案。
可发现「10:40 积分抢先购」这类时间窗，用于积分加速规划。

### `order-list` —— 历史订单

返回 `data.list[]`：`orderId`、`orderType`、`createTime`、`beType`、`beCode`、
`storeCode`、`storeName`、`orderStatus`、`orderProductList[]`、`realTotalAmount`。

> 用于校准积分获取速率。**注意**：历史订单不返回该单获得的积分，
> 需用账户积分变化与订单金额配对估算，故引擎中 `earnRate` 默认取 1 且可外部注入。

### `now-time-info` —— 服务器当前时间

返回 `timestamp`、`formatted`、`date`、`timezone` 等。**作为判断 `downTime` 是否过期的基准**，
避免用本地时钟误差导致上下架误判。

---

## 写操作工具（本 skill 默认不调用）

以下工具会**产生真实消费或扣分**，仅在用户明确要求并二次确认后调用：

| 工具 | 副作用 | 调用前必须确认 |
|---|---|---|
| `auto-bind-coupons` | 领取全部可用券（不花积分） | 告知将领取的券数量 |
| `draw-lottery` | 扣积分抽奖 | **单次消耗积分、剩余次数、奖品列表** |
| `mall-create-order` | 扣积分兑换 | **商品清单、总积分、总面值**；单件商品单独成单 |
| `party-order-create` | 创建派对订单（现金） | 城市/门店/日期/场次/价格 |
| `create-order` | 创建点餐订单（现金） | 门店、餐品、金额 |
| `cancel-order` | 取消订单 | 订单号、取消原因 |
| `delivery-create-address` | 新增配送地址 | 收货信息（涉及个人信息） |

---

## 错误码

| code | 原因 | 处理 |
|---|---|---|
| 401 | Token 无效/过期/未提供 | 重新到 open.mcd.cn/mcp 控制台申请 |
| 429 | 超频（>600 次/分钟） | 降低调用频率 |

---

## 调用流程示例

```
now-time-info          → 取得基准时间 T
query-my-account       → 可用积分 A
mall-points-products   → 商城清单 M
  ├─ 解析 spuName 得 faceValue
  ├─ 过滤 downTime < T
  └─ 过滤 point > 0 ∧ shopId = 2
query-lottery-info     → 抽奖规则
available-coupons      → 零成本券
→ 交由 points-engine.mjs 计算
```

`scripts/fetch-mcd-data.mjs` 实现了这一流程，并在落盘前脱敏
（剔除 `accountId`、`orderId`、`storeCode`、`beCode`）。
