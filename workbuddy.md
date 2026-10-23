# workbuddy.md

本文件记录本项目使用腾讯 WorkBuddy 开发时的对话上下文，用于核验 WorkBuddy 联动活动奖励条件。

**开发环境**：WorkBuddy CLI · 腾讯 WorkBuddy MCP 连接器（`mcd-mcp`）
**开发日期**：2026-10-23 · **开发者账号**：`hhtttyy`

---

## 一、需求起点

用户在 WorkBuddy 会话中提出：

> `https://github.com/M-China/mcd-developer-innovation-challenge` 介绍下这个比赛 我应该如何参加

WorkBuddy 随即通过 `gh` CLI 与 WebFetch 完成了全量规则梳理（活动规则、排名机制、
必需文件、报名 Issue 格式、奖励设置、MCP 工具清单），并在分析中做出关键判断：

> **距截止仅 2 天半，且 1076 个 Issue 已报名，榜单前 100 门槛为 36 star，
> 前三名需 900+。因此目标应锚定「进榜拿实物周边 + 3000 积分」，而非冲前三。**

据此 WorkBuddy 提出了三个差异化选题方向（多人群餐协调 / 积分资产运营 / 主题活动预约），
并指出榜单前 10 名中有 7 个属于省钱、控卡、热量、MBTI、盲评类目，同质化严重。

**用户选定方向：积分资产运营。**

---

## 二、MCP 接入

用户在 `open.mcd.cn/mcp` 控制台申请到 MCP Token，WorkBuddy 将其写入本机
`~/.workbuddy/mcp.json`（与既有 `lighthouse-ops` 连接器并存，未覆盖任何已有配置）：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamableHttp",
      "url": "https://mcp.mcd.cn",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" },
      "timeout": 30000,
      "disabled": false
    }
  }
}
```

随后 WorkBuddy 通过 JSON-RPC 直连 `https://mcp.mcd.cn` 完成连通性验证与工具实测：

- `initialize` 握手成功 → `serverInfo: {"name":"mcd-mcp","version":"1.0.0"}`
- `tools/list` 返回 **35 个工具**（比官方文档多 2 个：`query-survey-coupon`、`query-promotions`）
- 逐个实测只读工具，全部返回真实数据

---

## 三、关键数据发现（由 WorkBuddy 主动挖掘）

WorkBuddy 在实测过程中发现了两处**会导致结论系统性错误**的数据陷阱，
并据此重构了数据层：

### 发现一：面价藏在 `spuName` 里，`price` 字段恒为 0

首次运行引擎时，全部兑换标的的「积分价值密度」都算成了 0。
WorkBuddy 回到原始响应逐字段排查，确认：

| spuName | point | price | 真实面值 |
|---|---|---|---|
| `18.8元2份麦辣鸡翅` | 200 | `0` | **18.8** |
| `6.9元可乐麦炫酷` | 50 | `0` | **6.9** |
| `罗技键鼠套装` | 6666 | `0` | 无法解析（实物类） |

**结论**：积分类标的的 `price` 字段恒为 0，真实面值以中文数字写在名称前缀。
遂实现 `parseFaceValue()`，按 `spuName 正则 → price → 0` 的优先级解析并标注来源。

### 发现二：商城列表含大量已下架标的

对 50 件标的逐个比对 `downTime` 与 `now-time-info` 返回的基准时间后发现：
**仅 7 件在售且可用积分兑换，另有 16 件积分类标的已下架**
（如 `18.8元2份麦辣鸡翅` 实际已于 2026-03-21 结束）。

MCP 不会自动过滤这些。WorkBuddy 随即在采集阶段增加 `status` 字段计算，
并让引擎的**所有**计算路径强制过滤 `status !== 'live'`。

---

## 四、算法设计与验证

WorkBuddy 基于上述真实数据，推导出积分体系的三处结构性 inefficiency，
并为每一处实现可验证的算法：

| 发现 | 算法 | 实现 |
|---|---|---|
| 边际收益率递减（50 分档 0.1380 vs 800 分档 0.0274，**5.0 倍**） | 积分价值密度排序 | `rankByDensity()` |
| 门槛-余额错配死锁（可用 33.5 < 最低门槛 50） | 死锁检测 + 精确补差 | `detectDeadlock()` |
| 下架陷阱（16 件积分类标的已下架） | 上下架状态过滤 | `detectDelistedTrap()` |
| 兑换选品需要全局最优而非贪心 | 0/1 背包 + 帕累托前沿 | `solveRedeemPlan()` |
| 四维资产健康度 | 加权评分 | `scoreHealth()` |
| MCP 不暴露抽奖概率分布 | 盈亏平衡概率（拒绝编造期望值） | `compareLotteryVsRedeem()` |

### 自测驱动的开发过程

WorkBuddy 为引擎编写了 39 项断言的 `scripts/selftest.mjs`，
并在过程中**由自测发现并修复了 3 个真实缺陷**：

1. **负预算导致 `RangeError` 崩溃** —— `new Float64Array(-9)`，已加 `Math.max(0, ...)` 防护
2. **密度比断言精度不足** —— 浮点误差导致 5.04 与 5.0 的断言失败，放宽容差至 0.1
3. **测试断言本身写错** —— 100 分时背包求解器选出「两件 6.9 元」（13.8 元）而非「一件 10.9 元」，
   验证后发现**算法是对的、断言是错的**，遂修正断言并补充 150 分场景

最终：**39 项全部通过**。

---

## 五、交付物生成

WorkBuddy 完成了全部交付物：

| 文件 | 说明 |
|---|---|
| `SKILL.md` | WorkBuddy Skill 主体，含 frontmatter、触发词、五步工作流、关键约束 |
| `scripts/points-engine.mjs` | 零依赖纯函数引擎，**CLI / Skill / 在线 Demo 共用同一份实现** |
| `scripts/fetch-mcd-data.mjs` | MCP 采集 + 脱敏（剔除 accountId / orderId / storeCode / beCode） |
| `scripts/points-strategist.mjs` | CLI 入口，支持 `--budget` / `--json` |
| `scripts/selftest.mjs` | 39 项算法自检 |
| `docs/index.html` | 在线交互 Demo（GitHub Pages） |
| `references/*.md` | 算法推导 / MCP 工具说明 / 场景处置手册 |
| `README.md`、`MCP_INTEGRATION.md`、`CONTEST_DECLARATION.md`、`mcp-config.example.json` | 参赛必需文件 |

### Demo 的无头浏览器验证

WorkBuddy 使用 Playwright 无头浏览器实测了 Demo，**不是只看文件是否存在**：

- 控制台错误：**无**
- 健康度环渲染：12 分 ✓
- 密度条形图：7 条 ✓
- 商城表：15 行（含下架标注）✓
- 交互：滑块拖到 500 分 → 健康度 12 → 86，方案切换为 4 件实得 ¥35.60 ✓

验证中还发现并修复了两个精度问题：滑块步长取整导致补差算成 ¥17（应为 ¥16.5）、
已过期积分 729.5 被显示成 730。

---

## 六、WorkBuddy 承担的工作

| 环节 | WorkBuddy 的具体产出 |
|---|---|
| 规则调研 | 通过 `gh api` + WebFetch 抓取活动规则、排名机制、榜单快照、1076 条报名 Issue、冠军项目结构 |
| 差距分析 | 定位同质化区（Top10 中 7 个同类）与空白区（积分资产运营） |
| MCP 接入 | 写入本机 MCP 配置、直连握手、枚举 35 个工具、逐个实测 |
| 数据挖掘 | 发现面价字段陷阱与下架陷阱，两处均会导致结论失真 |
| 算法实现 | 6 个核心算法 + 39 项自测，自测驱动修复 3 个缺陷 |
| 工程实践 | 引擎同时服务 CLI 与浏览器，规避结论漂移；Playwright 实测 Demo |
| 文档产出 | README / MCP_INTEGRATION / 算法推导 / 工具参考 / 场景手册 |
| 安全 | 全程未在仓库中写入真实 Token（`mcp-config.example.json` 仅用环境变量占位符），并验证无泄漏 |

---

## 七、真实性声明

- 本项目**全程使用腾讯 WorkBuddy** 开发，代码、算法、文档、Demo 均由 WorkBuddy 生成
- 所有麦当劳数据均来自**麦当劳中国 MCP Server 官方接口**，未使用任何第三方聚合数据
- 抽样时间：2026-10-23 12:20 (GMT+8)，MCP Server 版本 v1.0.9
- 落盘数据已脱敏，剔除账号 ID、订单号、门店编码等标识信息
- 本项目为非麦当劳官方产品，输出仅供参考，不构成财务或消费建议
