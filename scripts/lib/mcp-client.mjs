/**
 * mcd-points-strategist · MCP 客户端（零依赖）
 *
 * 麦当劳中国 MCP Server：`https://mcp.mcd.cn`
 * 传输：Streamable HTTP，JSON-RPC 2.0 over POST
 * 鉴权：请求头 `Authorization: Bearer <MCP_TOKEN>`
 * 限流：每 Token 每分钟 600 次，超限返回 429
 *
 * 设计约束（来自项目约定）：
 *   1. 本模块只管「协议」，不含任何业务逻辑。
 *   2. 写操作工具（领券/下单/兑换/抽奖）**默认不调用**，必须显式 allowWrite。
 *   3. 5xx 不自动重试 —— 下单类接口重试可能造成重复下单；只对 429 重试。
 *   4. Token 只从环境变量或 .env 读取，**永不写入日志**。
 *
 * 用法：
 *   import { McpClient } from "../lib/mcp-client.mjs";
 *   const client = new McpClient();
 *   await client.initialize();
 *   const res = await client.callTool("query-my-account", {});
 */

import { env, exit } from "node:process";
import { readFileSync } from "node:fs";

export const MCP_URL = env.MCD_MCP_URL || "https://mcp.mcd.cn";

/** 服务端协议版本候选。官方文档未明确，按新到旧依次尝试。 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

/**
 * 会改动用户账号状态的工具。
 *
 * 探测器绝不调用这些；执行层必须逐一征得用户确认后才调用。
 * 与 mcd-wrapped 的 WRITE_TOOLS 保持同一份口径。
 */
export const WRITE_TOOLS = new Set([
  "auto-bind-coupons", // 一键领取全部麦麦省券
  "create-order", // 创建点餐订单
  "cancel-order", // 取消订单
  "mall-create-order", // 积分兑换下单（扣积分）
  "draw-lottery", // 消耗积分抽奖
  "party-order-create", // 主题活动下单
  "delivery-create-address", // 新增配送地址
]);

/** 轻量 .env 加载：项目根目录放 .env 即可，已被 .gitignore 排除。 */
function loadDotEnv() {
  try {
    const raw = readFileSync(new URL("../../.env", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* 没有 .env 则依赖环境变量 */
  }
}
loadDotEnv();

export class McpError extends Error {
  constructor(message, { code = null, retryable = false } = {}) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class McpClient {
  /**
   * @param {object} opts
   * @param {string} [opts.token]        MCP Token，默认取 MCD_MCP_TOKEN
   * @param {string} [opts.url]          服务地址，默认 https://mcp.mcd.cn
   * @param {number} [opts.timeout]      单次请求超时（毫秒）
   * @param {number} [opts.maxRetries]  429 重试次数上限
   */
  constructor({ token, url, timeout = 30000, maxRetries = 3 } = {}) {
    this.token = token || env.MCD_MCP_TOKEN || "";
    this.url = url || MCP_URL;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.sessionId = null;
    this.protocolVersion = PROTOCOL_VERSIONS[0];
    this._seq = 0;
    this._initialized = false;
    this.callLog = [];
  }

  _nextId() {
    return ++this._seq;
  }

  _headers() {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this._initialized) h["MCP-Protocol-Version"] = this.protocolVersion;
    return h;
  }

  /** 解析 SSE 帧或纯 JSON 响应体。 */
  static parseBody(raw) {
    const text = (raw || "").trim();
    if (!text) return null;
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return JSON.parse(text);
      } catch {
        /* 落到 SSE 解析 */
      }
    }
    const frames = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        frames.push(JSON.parse(payload));
      } catch {
        /* 跳过无法解析的帧 */
      }
    }
    return frames.length ? frames : null;
  }

  async _post(body, { notify = false } = {}) {
    let res;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (e) {
      throw new McpError(`网络请求失败：${e.message}（请检查网络或 MCD_MCP_URL）`);
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 401) {
      throw new McpError(
        "HTTP 401：MCP Token 无效或已过期。请到 open.mcd.cn/mcp 控制台重新登录并激活获取 Token。"
      );
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      throw new McpError("HTTP 429：触发限流（MCP 为每分钟 600 次/Token）", {
        code: 429,
        retryable: true,
        retryAfter: retryAfter * 1000,
      });
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      // 5xx 视为「可能已产生副作用」，不自动重试
      throw new McpError(`HTTP ${res.status}：${detail}`, { code: res.status, retryable: false });
    }

    const text = await res.text();
    if (notify) return null;
    return McpClient.parseBody(text);
  }

  async _rpc(method, params, { notify = false } = {}) {
    const body = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: this._nextId(), method, params };

    const frames = await this._post(body, { notify });
    if (notify) return null;
    const list = Array.isArray(frames) ? frames : frames ? [frames] : [];
    const resp = list.find((f) => f && f.id === body.id);
    if (!resp) throw new McpError(`MCP 未返回 ${method} 的响应帧`);
    if (resp.error) {
      throw new McpError(`MCP 错误 ${resp.error.code}：${resp.error.message}`);
    }
    return resp.result;
  }

  /**
   * 初始化握手。双协议版本依次尝试，成功后固化版本与 session。
   */
  async initialize() {
    if (this._initialized) return;
    if (!this.token) {
      throw new McpError(
        "缺少 MCP Token。请到 https://open.mcd.cn/mcp 手机号登录 → 控制台 → 激活 → 复制 Token，" +
          "然后 export MCD_MCP_TOKEN=<你的Token>（或在项目根目录 .env 写入）。"
      );
    }
    let lastErr = null;
    for (const v of PROTOCOL_VERSIONS) {
      this.sessionId = null; // 每次握手重开会话
      try {
        const result = await this._rpc("initialize", {
          protocolVersion: v,
          capabilities: {},
          clientInfo: { name: "mcd-points-strategist", version: "2.0.0" },
        });
        this.protocolVersion = result?.protocolVersion || v;
        await this._rpc("notifications/initialized", {}, { notify: true });
        this._initialized = true;
        return result;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async listTools() {
    await this.initialize();
    const res = await this._rpc("tools/list", {});
    return (res || {}).tools || [];
  }

  /**
   * 调用一个 MCP 工具。
   *
   * @param {string} name  工具名
   * @param {object} args  入参
   * @param {object} opts
   * @param {boolean} [opts.allowWrite]  是否允许调用写操作工具，默认 false
   * @returns {Promise<any>} 解析后的工具结果（JSON 或文本）
   */
  async callTool(name, args = {}, { allowWrite = false } = {}) {
    if (!allowWrite && WRITE_TOOLS.has(name)) {
      throw new McpError(
        `工具 ${name} 会改动账号状态，已被安全策略拦截。` +
          `确需调用时显式传入 { allowWrite: true }，并确保已获得用户确认。`
      );
    }
    await this.initialize();

    let attempt = 0;
    for (;;) {
      try {
        const res = await this._rpc("tools/call", { name, arguments: args });
        this.callLog.push({ name, at: new Date().toISOString(), write: WRITE_TOOLS.has(name) });
        return unwrap(res);
      } catch (e) {
        if (e instanceof McpError && e.retryable && attempt < this.maxRetries) {
          const wait = e.retryAfter || Math.min(1000 * 2 ** attempt, 8000);
          attempt += 1;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * 尝试一个工具，失败时返回错误信息而不是抛出 —— 巡检场景下单项失败不应拖垮全局。
   */
  async tryTool(name, args = {}, { allowWrite = false } = {}) {
    try {
      const data = await this.callTool(name, args, { allowWrite });
      return { ok: true, name, data };
    } catch (e) {
      return { ok: false, name, error: String(e?.message || e).slice(0, 200) };
    }
  }
}

/**
 * 把 MCP 的 content 块拆成可读文本。
 *
 * 实测坑位：多数工具返回的是 **Markdown 文本**，真 JSON 藏在
 * `## Original Response` 之后；`list-nutrition-foods` 更是自定义的逗号分隔文本表，
 * 不是 JSON。无数据时返回中文文案（如「暂无可用优惠券」）而不是空数组。
 */
export function unwrap(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;

  const parts = (result.content || [])
    .map((c) => (typeof c === "string" ? c : c?.text || ""))
    .filter(Boolean);
  const text = parts.join("\n").trim();
  if (!text) return null;

  const marker = "## Original Response";
  if (text.includes(marker)) {
    const tail = text.slice(text.indexOf(marker) + marker.length).trim();
    try {
      return JSON.parse(tail);
    } catch {
      return tail;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 提取工具的原始文本（不做 JSON 解析）—— 解析 Markdown 表时需要它。
 */
export function rawText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  const parts = (result.content || [])
    .map((c) => (typeof c === "string" ? c : c?.text || ""))
    .filter(Boolean);
  return parts.join("\n").trim();
}

/** 命令行入口：node scripts/lib/mcp-client.mjs tools | call <tool> '<json>' */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=scripts)/, ""))) {
  const cmd = process.argv[2];
  const client = new McpClient();
  try {
    if (cmd === "tools") {
      const tools = await client.listTools();
      console.log(`共 ${tools.length} 个工具：\n`);
      for (const t of tools) {
        const req = t.inputSchema?.required || [];
        const props = Object.entries(t.inputSchema?.properties || {}).map(
          ([k, v]) => `${k}${req.includes(k) ? "*" : ""}:${v.type || "any"}`
        );
        const write = WRITE_TOOLS.has(t.name) ? " [写]" : "";
        console.log(`◆ ${t.name}${write}`);
        if (t.description) console.log(`  ${t.description.replace(/\n/g, " ").slice(0, 110)}`);
        if (props.length) console.log(`  参数：${props.join("，")}`);
      }
    } else if (cmd === "call") {
      const name = process.argv[3];
      const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
      const write = WRITE_TOOLS.has(name);
      const res = await client.callTool(name, args, { allowWrite: write });
      console.log(typeof res === "string" ? res : JSON.stringify(res, null, 2));
    } else {
      console.log("用法：mcp-client.mjs tools | call <tool> '<json>'");
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    exit(1);
  }
}
