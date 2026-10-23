# live fixtures · 真实 MCP 响应快照

采集时间：2026-10-23 15:47（GMT+8）
来源：麦当劳中国 MCP Server `https://mcp.mcd.cn`，真实账号调用

## 为什么要有这批 fixture

早期 `fixtures/reference/` 里的响应是**脱敏重构**过的 —— 字段名被改写过
（`title` → `name`），格式也被整理成了整齐的 Markdown。
结果：**解析器在 fixture 上全绿，在真实响应上全空**。

这批 fixture 是**原样保存的真实响应**（只脱敏了签名 URL、账户 ID 与券码），
用来做回归测试，确保解析器永远贴着真实结构。

## 三个被这批 fixture 抓出来的真实坑

1. **MCP 响应不是标准信封**
   真实返回是业务 JSON **直挂顶层**：`{ success, code, data }`，
   没有 `{ content: [{ text }] }`。早期 `rawText()` 只认 content 数组，
   对这些工具一律返回空字符串 → 券 0 张 / 活动 0 天 / 门店 0 家。

2. **活动标题在 `articleDto.title`，不在 `activityTitle`**
   顶层 `activityTitle` 是**空串**。读错字段会让所有活动标题变空数组，
   看板出现「今日活动 0 个」但待办又说「今天有 1 个活动」的自相矛盾。

3. **`discountDesc: "用券价格"` 意味着「你付的钱」，不是「省的钱」**
   「1024码力翻倍 ¥20.48」= 两件套到手价 ¥20.48。
   当成「省了 20.48 元」会让沉默成本与积分折算全部虚高。

## 用法

```bash
node scripts/app/selftest-live.mjs
```
