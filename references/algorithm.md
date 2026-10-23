# 算法说明

本 skill 的每个结论都由下列公式推导而来。所有公式在 `scripts/points-engine.mjs` 中实现，
并由 `scripts/selftest.mjs` 的 39 项断言覆盖。

---

## 1. 积分价值密度（Point Value Density）

定义某兑换标的的**积分价值密度**为每投入 1 积分换得的现金价值：

```
density(i) = faceValue(i) / point(i)     [元/积分]
```

**faceValue 的来源必须注意**：MCP 的 `mall-points-products` 中，积分类标的（`point > 0`）
其 `price` 字段恒为 `0`，真实面值藏在 `spuName` 前缀中：

| spuName | point | price 字段 | 解析出的 faceValue |
|---|---|---|---|
| `18.8元2份麦辣鸡翅` | 200 | `0` | **18.8**（来自 spuName） |
| `6.9元可乐麦炫酷` | 50 | `0` | **6.9**（来自 spuName） |
| `罗技键鼠套装` | 6666 | `0` | 0（无法解析，实物类，不参与排名） |
| `麦当劳奇妙生日派对` | 0 | `50` | 50（现金类，`point=0`，不参与排名） |

因此 `faceValue` 的解析优先级为：`spuName` 正则 `^([\d.]+)\s*元` → `price` 字段 → 0（未知）。

> 若误用 `price` 字段，全部积分类标的密度均为 0，排序结果完全失真。

### 边际收益率递减

档位之间的密度递减是麦当劳商城的设计特征，而非偶然。实测：

```
最优档：50 分 → ¥6.9   density = 0.1380
最差档：800 分 → ¥21.9  density = 0.0274
递减倍数 = 0.1380 / 0.0274 = 5.04×
```

**推论**：为高面值档位攒积分存在机会成本。800 分可以换 16 件 6.9 元券（面值 110.4 元），
却只能换 1 件 21.9 元券。**决策必须用背包求解，不能用贪心。**

---

## 2. 资产健康度评分（0-100）

四个维度加权求和：

```
score = 100 × (0.40·survival + 0.25·realization + 0.25·efficiency + 0.10·vitality)
```

### 2.1 存活率 survival（权重 40%）

```
survival = clamp01(availablePoint / accumulativePoint)
```

累计获得的积分中，有多少还躺在账户里。低存活率意味着历史积分大部分被清零。

### 2.2 变现率 realization（权重 25%）

当前余额能匹配到的**最佳可达密度**占全站最佳密度的比例：

```
bestDensity   = max(density(i))                  over all live redeemable items
bestReachable = max(density(i)) where point(i) ≤ availablePoint
realization   = clamp01(bestReachable / bestDensity)
```

余额够不到最优档时，realization → 0。这是「死锁」的量化表达。

### 2.3 效率 efficiency（权重 25%）

与 realization 同源，此处保留独立维度以区分「完全够不到」与「能换但换得不划算」两种衰减。

### 2.4 临期安全度 vitality（权重 10%）

```
vitality = clamp01(1 - currentMouthExpirePoint / availablePoint)
```

本月将过期积分占比越高，vitality 越低（越紧急）。
注意语义方向：vitality 是**安全度**（越高越好、进度条越长越好），
与「压力」相反，命名为「临期安全度」以避免进度条被误读。

### 2.5 衰减率 decayRate

```
decayRate = expiredPoint / accumulativePoint
```

独立于 score 单独汇报——它是最直观的浪费指标。

---

## 3. 门槛-余额错配死锁检测

定义**高 ROI 档位集合**：

```
threshold  = max(density) × 0.6
highROI    = { i : density(i) ≥ threshold ∧ status(i) = live ∧ shopId(i) = 2 }
reachable  = { i ∈ highROI : point(i) ≤ availablePoint }
```

- `reachable ≠ ∅` → 无死锁，正常输出兑换方案
- `reachable = ∅` → **死锁**，输出补差规划

### 补差规划

```
gap        = max(0, target.point - availablePoint)
spendNeeded = gap / earnRate
```

`earnRate` 为积分获取速率（积分/元）。麦当劳麦享会体系下消费 1 元约得 1 积分，
可用 `order-list` 的历史订单金额与积分变化校准，默认 `1.0`。

死锁时的正确解不是「继续攒」（那只会让更多积分过期），而是**精确补差**：
消费刚好跨过门槛的最小金额，立刻兑换高密度档位。

---

## 4. 0/1 背包最优兑换组合

约束：每件商品单独成单（`mall-create-order` 要求），故每件标的至多选一次 → **0/1 背包**。

```
目标：max Σ cashValue(i)·x(i)
约束：Σ point(i)·x(i) ≤ budget,  x(i) ∈ {0,1}
```

标准 DP：

```
dp[i][c] = 用前 i 件、总分不超过 c 时的最大现金价值
dp[i][c] = max( dp[i-1][c],  dp[i-1][c - point(i)] + cashValue(i) )
```

回溯得到最优组合。同时计算**帕累托前沿**（非支配解集合）：

```
i 被 j 支配 ⟺ point(j) ≤ point(i) ∧ cashValue(j) ≥ cashValue(i)
           ∧ (point(j) < point(i) ∨ cashValue(j) > cashValue(i))
```

前沿让用户自行权衡「多花积分」与「多换面值」——在积分会过期的场景下，
有时少花一点、多换一点面值反而是更优解。

---

## 5. 抽奖 vs 兑换：盈亏平衡分析

`query-lottery-info` **不暴露奖品概率分布**。任何点估计期望值都是编造，因此本 skill 不做。

改为输出可证伪的**盈亏平衡概率**：

设单次抽奖消耗 `d` 积分，同额积分直接兑换可得 `redeemValue = d × bestDensity` 元。
奖品价值区间为 `[worst, best]`，其中 `worst`、`best` 来自奖品名义价值表。

设抽中最高价值奖品的概率为 `p`，则抽奖的期望价值为：

```
E[抽奖] = p·best + (1-p)·worst
```

令 `E[抽奖] = redeemValue` 解出临界概率：

```
p* = (redeemValue - worst) / (best - worst)
```

- 若 `p* ≤ 0`：抽奖的最低价值已不低于兑换，**直接抽奖**
- 若 `p* > 0`：`p*` 就是盈亏平衡点。只有当「抽中大奖的概率 > p*」时，抽奖才更划算。
  概率未知时，结论是「不确定」，而不是伪造一个期望值。

---

## 6. 行动优先级模型

所有可选动作按「即时收益 ÷ 成本」排序：

| 优先级 | 动作类型 | 成本 | 排序理由 |
|---|---|---|---|
| 1 | `claim_coupon` 领零成本券 | 0 | 零成本零风险，先拿完再谈积分 |
| 2 | `avoid_trap` 避开下架标的 | 0 | 防止为已结束活动攒分（纯浪费） |
| 3 | `top_up` 精确补差 | ¥ | 死锁时的唯一正解 |
| 4 | `draw` 抽奖 | 积分 | 把沉没积分转成实物/券期望值 |
| 5 | `redeem` 兑换 | 积分 | 在有更优档位时执行 |

排序原则：**先做零成本且能避免损失的动作，再做有成本的动作**。

---

## 7. 已知的模型局限

诚实标注，避免过度承诺：

1. **抽奖概率未知** —— 盈亏平衡分析需要外部提供奖品价值表，MCP 不提供概率分布。
2. **面值解析依赖名称格式** —— 实物类商品（罗技键鼠、Nike 联名鞋）无法从名称解析面值，
   会被排除在密度排名外。若需评估实物档位，需人工补充价值表。
3. **积分获取速率是估算** —— 默认 1 积分/元，未考虑活动加速、会员等级加成等因素。
4. **不含外部信息** —— 不查询第三方优惠券聚合站，只用麦当劳官方 MCP 数据。
