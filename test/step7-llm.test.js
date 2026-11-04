/* ===================================================================
   第七步测试：智谱 GLM 意图识别（llm.js）+ chat.js 的 action 分发
   运行：node test/step7-llm.test.js
   覆盖：
   - callLLM：正常 JSON / ```json 包裹 / 带前后缀文字 / change_mode /
     缺 mode / 未知 action / HTTP 错误 / 超时 abort / 无 Key / 空输入
   - 请求体：model / temperature=0 / messages 结构 / Authorization 头
   - extractJson / normalize 边界：数组、缺 action、无花括号
   - isReady：有 / 无 Key
   - chat.js 分发：depart_now / change_mode / query_weather / none /
     LLM 抛错降级正则 / 无 Key 不发请求 / 思考气泡添加与移除 /
     applyModeChange 表单+云端+卡片重算 / 降级提示文案
   =================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log("  ✓ " + name); }
  catch (e) { results.push({ name, ok: false, err: e }); console.log("  ✗ " + name + "\n    " + e.message); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "断言失败"); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "不相等") + "：实际 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b)); }

/* ---------------- 迷你 DOM ---------------- */
const VOID = { input: 1, br: 1, img: 1, hr: 1, meta: 1, link: 1 };
function dec(s) {
  return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function parseHTML(root, html) {
  const stack = [root];
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[2]) {
      const el = new El(m[2].toLowerCase());
      const ar = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let am;
      while ((am = ar.exec(m[3] || ""))) {
        const v = am[2] != null ? am[2] : (am[3] != null ? am[3] : (am[4] != null ? am[4] : ""));
        el.attrs[am[1]] = dec(v);
      }
      if (el.attrs.class) el.className = el.attrs.class; // 同步 className，否则 querySelector('.x') 失效
      stack[stack.length - 1].appendChild(el);
      if (el.attrs.value !== undefined) el._value = el.attrs.value;
      if (!VOID[m[2].toLowerCase()] && m[4] !== "/") stack.push(el);
      continue;
    }
    if (m[5] != null) { const t = dec(m[5]); if (t.trim()) stack[stack.length - 1]._text += t; }
  }
}
class El {
  constructor(t) {
    this.tagName = String(t).toUpperCase();
    this.children = []; this.parentNode = null; this.attrs = {};
    this.className = ""; this._text = ""; this._value = ""; this.isConnected = true;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  _all(o) { for (const c of this.children) { o.push(c); c._all(o); } return o; }
  querySelectorAll(s) {
    // 支持单类 .a / 多类 .a.b（同一元素需同时具备）；暂不支持后代选择器
    if (s.startsWith(".")) {
      const want = s.slice(1).split(".").filter(Boolean);
      return this._all([]).filter((e) => want.every((c) => (e.className || "").split(/\s+/).includes(c)));
    }
    return this._all([]).filter((e) => e.tagName === s.toUpperCase());
  }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  set innerHTML(h) { this.children = []; parseHTML(this, h); }
  get innerHTML() { return ""; }
  get textContent() {
    return (this._text || "") + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) { this._text = String(v == null ? "" : v); this.children = []; }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i > -1) this.parentNode.children.splice(i, 1); } this.isConnected = false; }
}

/* ---------------- 环境 ---------------- */
function loadScript(file, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, { filename: file });
}

// 只加载 llm.js + config.js 的环境（LLM 单元测试）
function buildLlmEnv(opts) {
  opts = opts || {};
  const store = new Map();
  const fetchCalls = [];
  const sandbox = {
    console,
    ZHIPU_CONFIG: undefined,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      if (opts.fetchImpl) return opts.fetchImpl(url, init);
      throw new Error("no fetch mock");
    },
    AbortController: class {
      constructor() {
        this._l = [];
        this.signal = {
          aborted: false,
          addEventListener: (t, f) => this._l.push(f),
        };
      }
      abort() {
        this.signal.aborted = true;
        this._l.forEach((f) => f());
      }
    },
    setTimeout: (fn) => { if (opts.setTimeoutNow) fn(); return 0; },
    clearTimeout: () => {},
  };
  sandbox.window = sandbox;
  loadScript("assets/js/config.js", sandbox);
  if (opts.key !== undefined) sandbox.ZHIPU_CONFIG.key = opts.key;
  if (opts.model) sandbox.ZHIPU_CONFIG.model = opts.model;
  // 默认直连模式：清空 config.js 注入的 proxyUrl，避免干扰单测；显式传 proxyUrl 才测代理
  sandbox.ZHIPU_CONFIG.proxyUrl = (typeof opts.proxyUrl !== "undefined") ? opts.proxyUrl : "";
  loadScript("assets/js/llm.js", sandbox);
  return { sandbox, fetchCalls, store };
}

// 智谱成功响应的 mock
function zhipuResp(content) {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { role: "assistant", content } }] }),
    text: async () => "",
  };
}

(async () => {
console.log("=== LLM 单元测试（llm.js）===");

await test("isReady：无 Key → false", () => {
  const { sandbox } = buildLlmEnv({ key: "" });
  eq(sandbox.LLM.isReady(), false, "空 key");
});

await test("isReady：有 Key → true", () => {
  const { sandbox } = buildLlmEnv({ key: "test.key123" });
  eq(sandbox.LLM.isReady(), true, "配置了 key");
});

await test("callLLM：正常 JSON → depart_now", async () => {
  const { sandbox, fetchCalls } = buildLlmEnv({
    key: "k", fetchImpl: async () => zhipuResp('{"action":"depart_now"}'),
  });
  const r = await sandbox.LLM.callLLM("我马上要走了");
  eq(r.action, "depart_now", "action");
  eq(fetchCalls.length, 1, "发了一次请求");
  eq(fetchCalls[0].url, "https://open.bigmodel.cn/api/paas/v4/chat/completions", "端点");
  const h = fetchCalls[0].init.headers;
  eq(h.Authorization, "Bearer k", "Authorization 头");
  eq(h["Content-Type"], "application/json", "Content-Type");
  const body = JSON.parse(fetchCalls[0].init.body);
  eq(body.model, "glm-4-flash", "默认模型");
  eq(body.temperature, 0, "temperature=0 确定性");
  eq(body.max_tokens, 256, "max_tokens");
  eq(body.messages.length, 2, "system + user 两条");
  eq(body.messages[0].role, "system", "首条 system");
  ok(/只输出 JSON/.test(body.messages[0].content), "System Prompt 含 JSON 约束");
  ok(body.messages[1].content.includes("我马上要走了"), "user 含原文");
});

await test("callLLM：动态上下文（当前通勤方式）进入 user 消息", async () => {
  const { sandbox, fetchCalls } = buildLlmEnv({
    key: "k", fetchImpl: async () => zhipuResp('{"action":"none"}'),
  });
  await sandbox.LLM.callLLM("今天不骑车了", { context: { mode: "骑行", nowText: "14:30" } });
  const body = JSON.parse(fetchCalls[0].init.body);
  ok(body.messages[1].content.includes("用户当前通勤方式：骑行"), "含当前方式");
  ok(body.messages[1].content.includes("当前时间：14:30"), "含当前时间");
});

await test("callLLM：走代理（key 空 + proxyUrl）→ 发往代理地址且不带 Authorization", async () => {
  const { sandbox, fetchCalls } = buildLlmEnv({
    key: "", proxyUrl: "https://proxy.test/x", fetchImpl: async () => zhipuResp('{"action":"none"}'),
  });
  eq(sandbox.LLM.hasProxy(), true, "hasProxy()=true");
  const r = await sandbox.LLM.callLLM("我马上要走了");
  eq(r.action, "none", "action");
  eq(fetchCalls[0].url, "https://proxy.test/x", "发往代理地址而非官方端点");
  eq(fetchCalls[0].init.headers.Authorization, undefined, "代理模式前端不发送 Authorization（Key 由服务端持有）");
});

await test("isReady：有代理且 Key 为空 → true", () => {
  const { sandbox } = buildLlmEnv({ key: "", proxyUrl: "https://proxy.test/x" });
  eq(sandbox.LLM.isReady(), true, "配置了代理即视为就绪");
  eq(sandbox.LLM.hasProxy(), true, "hasProxy()=true");
});

await test("callLLM：change_mode 带 mode → 原样保留", async () => {
  const { sandbox } = buildLlmEnv({
    key: "k", fetchImpl: async () => zhipuResp('{"action":"change_mode","mode":"walking"}'),
  });
  const r = await sandbox.LLM.callLLM("今天不骑车了，我想走路");
  eq(r.action, "change_mode", "action");
  eq(r.mode, "walking", "mode");
});

await test("callLLM：```json 代码块包裹 → 清洗后解析", async () => {
  const { sandbox } = buildLlmEnv({
    key: "k",
    fetchImpl: async () => zhipuResp('```json\n{"action":"depart_now"}\n```'),
  });
  const r = await sandbox.LLM.callLLM("出发");
  eq(r.action, "depart_now", "剥掉代码块");
});

await test("callLLM：带前后缀解释文字 → 截取花括号", async () => {
  const { sandbox } = buildLlmEnv({
    key: "k",
    fetchImpl: async () => zhipuResp('好的，结果是：\n{"action":"query_weather"}\n以上。'),
  });
  const r = await sandbox.LLM.callLLM("会下雨吗");
  eq(r.action, "query_weather", "截取 JSON");
});

await test("callLLM：change_mode 缺 mode → none", async () => {
  const { sandbox } = buildLlmEnv({
    key: "k", fetchImpl: async () => zhipuResp('{"action":"change_mode"}'),
  });
  const r = await sandbox.LLM.callLLM("换个方式");
  eq(r.action, "none", "缺 mode 归一 none");
});

await test("callLLM：mode 不在白名单 → none", async () => {
  const { sandbox } = buildLlmEnv({
    key: "k", fetchImpl: async () => zhipuResp('{"action":"change_mode","mode":"teleport"}'),
  });
  const r = await sandbox.LLM.callLLM("瞬移");
  eq(r.action, "none", "非法 mode");
});

await test("callLLM：未知 action → none（不抛错）", async () => {
  const { sandbox } = buildLlmEnv({
    key: "k", fetchImpl: async () => zhipuResp('{"action":"launch_rocket"}'),
  });
  const r = await sandbox.LLM.callLLM("发射火箭");
  eq(r.action, "none", "未知 action");
});

await test("callLLM：HTTP 401 → reject（调用方降级）", async () => {
  const { sandbox } = buildLlmEnv({
    key: "bad",
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":{"code":"1001"}}', json: async () => ({}) }),
  });
  let err = null;
  try { await sandbox.LLM.callLLM("hi"); } catch (e) { err = e; }
  ok(err, "应当 reject");
  ok(/401/.test(err.message), "错误信息含状态码：" + (err && err.message));
});

await test("callLLM：fetch 网络错误 → reject", async () => {
  const { sandbox } = buildLlmEnv({ key: "k", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  let err = null;
  try { await sandbox.LLM.callLLM("hi"); } catch (e) { err = e; }
  ok(err && /Failed to fetch/.test(err.message), "网络错误上抛");
});

await test("callLLM：超时中断 → reject（AbortError）", async () => {
  const { sandbox } = buildLlmEnv({
    key: "k",
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      // 真实模拟：abort 已触发或触发中 → reject AbortError
      if (init.signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      // 否则永远不 settle（模拟挂起的请求）
    }),
    setTimeoutNow: true, // mock setTimeout 立即执行 → 立刻 abort
  });
  const err = await sandbox.LLM.callLLM("hi").catch((e) => e);
  ok(err instanceof Error, "超时应 reject：" + (err && err.name));
  eq(err.name, "AbortError", "abort 语义");
});

await test("callLLM：无 Key → reject（不发请求）", async () => {
  const { sandbox, fetchCalls } = buildLlmEnv({ key: "", fetchImpl: async () => zhipuResp('{"action":"none"}') });
  let err = null;
  try { await sandbox.LLM.callLLM("hi"); } catch (e) { err = e; }
  ok(err && /Key/.test(err.message), "提示缺 Key");
  eq(fetchCalls.length, 0, "未发请求");
});

await test("callLLM：空输入 → 直接 none（不发请求）", async () => {
  const { sandbox, fetchCalls } = buildLlmEnv({ key: "k", fetchImpl: async () => zhipuResp('{"action":"depart_now"}') });
  const r = await sandbox.LLM.callLLM("   ");
  eq(r.action, "none", "空输入");
  eq(fetchCalls.length, 0, "未发请求");
});

await test("callLLM：响应无 choices → reject", async () => {
  const { sandbox } = buildLlmEnv({
    key: "k",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
  });
  let err = null;
  try { await sandbox.LLM.callLLM("hi"); } catch (e) { err = e; }
  ok(err && /为空/.test(err.message), "空响应上抛");
});

await test("extractJson 边界：纯文本/空串 → throw；数组/对象均可解析", () => {
  const { sandbox } = buildLlmEnv({ key: "k" });
  let e1 = null, e3 = null;
  try { sandbox.LLM.extractJson("没有 JSON"); } catch (e) { e1 = e; }
  try { sandbox.LLM.extractJson(""); } catch (e) { e3 = e; }
  ok(e1, "无花括号（纯文本）→ throw");
  ok(e3, "空串 → throw");
  const arr = sandbox.LLM.extractJson("[1,2,3]");
  ok(Array.isArray(arr) && arr.length === 3, "数组可解析（视觉识别返回数组）");
  const obj = sandbox.LLM.extractJson('{"action":"none"}');
  ok(obj && obj.action === "none", "对象可解析（意图识别）");
});

await test("normalize 边界：数组 / 缺 action → throw；非法 action → none", () => {
  const { sandbox } = buildLlmEnv({ key: "k" });
  let e1 = null, e2 = null;
  try { sandbox.LLM.normalize([1]); } catch (e) { e1 = e; }
  try { sandbox.LLM.normalize({ mode: "walking" }); } catch (e) { e2 = e; }
  ok(e1, "数组");
  ok(e2, "缺 action");
  eq(sandbox.LLM.normalize({ action: "depart_now" }).action, "depart_now", "合法");
});

await test("normalize：query_commute 透传 origin/when/course", () => {
  const { sandbox } = buildLlmEnv({ key: "k" });
  const r = sandbox.LLM.normalize({ action: "query_commute", origin: "图书馆", when: "today_evening", course: "高数" });
  eq(r.action, "query_commute", "action");
  eq(r.origin, "图书馆", "origin");
  eq(r.when, "today_evening", "when");
  eq(r.course, "高数", "course");
});

await test("System Prompt 覆盖全部 action 与 mode 定义", () => {
  const { sandbox } = buildLlmEnv({ key: "k" });
  const p = sandbox.LLM.SYSTEM_PROMPT;
  ["depart_now", "change_mode", "query_weather", "query_commute", "none", "walking", "cycling", "transit", "只输出 JSON"].forEach((k) => {
    ok(p.includes(k), "System Prompt 应包含 " + k);
  });
});

/* ================= chat.js 分发测试 ================= */
console.log("\n=== chat.js action 分发测试 ===");

function buildChatEnv(opts) {
  opts = opts || {};
  const store = new Map();
  const calls = { departForNext: 0, saveSettings: [], saveSchedule: [], checkWeather: 0, recompute: 0 };
  const box = new El("div"); box.id = "messageList";
  const chatScroll = new El("div");
  const departInput = new El("input"); departInput.value = opts.origin || "梅园 3 栋 518";
  const modeSel = new El("select");
  modeSel.options = [{ text: "步行", value: "步行" }, { text: "骑行", value: "骑行" }, { text: "校内公交", value: "校内公交" }];
  modeSel.selectedIndex = opts.modeIndex || 0;
  const advInput = new El("input"); advInput.value = "10";
  const els = { messageList: box, chatScroll: chatScroll, "set-depart": departInput, "set-mode": modeSel, "set-advance": advInput, "set-school": new El("input"), "set-semester": new El("input"), "set-weather": new El("input"), "set-notify": new El("input") };
  const sandbox = {
    console,
    ZHIPU_CONFIG: { key: opts.key === undefined ? "" : opts.key, model: "glm-4-flash" },
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (t) => new El(t),
      addEventListener: () => {},
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    fetch: async (url, init) => {
      calls.fetch = (calls.fetch || 0) + 1;
      if (opts.fetchImpl) return opts.fetchImpl(url, init);
      throw new Error("no fetch mock");
    },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout: (fn) => { if (opts.runTimers !== false) fn(); return 0; },
    clearTimeout: () => {},
  };
  sandbox.window = sandbox;
  sandbox.LLM_MODULE_READY = true;
  loadScript("assets/js/config.js", sandbox);
  sandbox.ZHIPU_CONFIG.key = opts.key === undefined ? "" : opts.key; // config.js 会把 key 重置为空，加载后再设
  sandbox.ZHIPU_CONFIG.proxyUrl = ""; // 默认直连模式，避免 config.js 的代理地址干扰单测
  loadScript("assets/js/llm.js", sandbox);
  loadScript("assets/js/schedule-core.js", sandbox);
  // 依赖打桩
  sandbox.AutoPush = {
    departForNext: () => { calls.departForNext++; },
    render: (o) => { if (o && o.recompute) calls.recompute++; },
    setSemesterStart: () => {},
  };
  sandbox.ScheduleCore = {
    state: { rows: [], pending: null, pendingConfirmed: false },
    getRows: () => [],
    setRows: () => {},
    syncInputs: () => {},
    parseEdit: (t) => (t.includes("第 2 节") ? { ok: true, ack: "已更新第 2 节" } : null),
  };
  sandbox.AppData = {
    loadSettings: async () => opts.cloudSettings || {},
    saveSettings: async (s) => { calls.saveSettings.push(s); },
    saveSchedule: async (r) => { calls.saveSchedule.push(r); },
  };
  sandbox.CommuteAPI = { checkWeather: async () => { calls.checkWeather++; return { text: "晴 ☀️" }; } };
  sandbox.getSchedule = () => [];
  loadScript("assets/js/chat.js", sandbox);
  return { sandbox, calls, box, els, store };
}

await test("分发：LLM depart_now → 触发 AutoPush.departForNext", async () => {
  const { sandbox, calls, box } = buildChatEnv({
    key: "k",
    fetchImpl: async () => zhipuResp('{"action":"depart_now"}'),
  });
  await sandbox.dispatchUserText("我马上要走了");
  eq(calls.departForNext, 1, "触发现在出发");
  ok(box.querySelectorAll(".msg.agent").length === 0, "思考气泡已移除，无多余气泡");
});

await test("分发：LLM change_mode → 表单/内存/云端/卡片全部更新", async () => {
  const { sandbox, calls, els, box } = buildChatEnv({
    key: "k",
    fetchImpl: async () => zhipuResp('{"action":"change_mode","mode":"cycling"}'),
  });
  await sandbox.dispatchUserText("今天我想骑车");
  eq(calls.saveSettings.length, 1, "保存了一次设置");
  eq(calls.saveSettings[0].commute_mode, "骑行", "只改 commute_mode");
  eq(els["set-mode"].selectedIndex, 1, "表单选中「骑行」");
  eq(calls.recompute, 1, "通勤卡片重算");
  const agentMsgs = box.querySelectorAll(".msg.agent");
  ok(agentMsgs.length >= 1, "有确认气泡");
  ok(/已切换到/.test(agentMsgs[agentMsgs.length - 1].textContent), "回复含切换确认");
});

await test("分发：LLM query_weather → 调用天气 API 并回复", async () => {
  const { sandbox, calls, box } = buildChatEnv({
    key: "k",
    fetchImpl: async () => zhipuResp('{"action":"query_weather"}'),
  });
  await sandbox.dispatchUserText("今天会下雨吗");
  eq(calls.checkWeather, 1, "查了天气");
  const agent = box.querySelectorAll(".msg.agent");
  ok(agent.length >= 1, "有回复气泡");
  ok(agent[agent.length - 1].textContent.indexOf("晴 ☀️") > -1, "回复含天气文案");
});

await test("分发：LLM none → 走本地链路（课表修改命中）", async () => {
  const { sandbox, calls, box } = buildChatEnv({
    key: "k",
    fetchImpl: async () => zhipuResp('{"action":"none"}'),
  });
  await sandbox.dispatchUserText("第 2 节结束时间改成 15:40");
  eq(calls.saveSchedule.length, 1, "课表已保存");
  ok(box.querySelectorAll(".msg.agent").length >= 1, "有确认气泡");
});

await test("分发：LLM none 且本地也不命中 → 准确提示（非演示模式文案）", async () => {
  const { sandbox, calls, box } = buildChatEnv({
    key: "k",
    fetchImpl: async () => zhipuResp('{"action":"none"}'),
  });
  await sandbox.dispatchUserText("你好呀");
  eq(calls.departForNext, 0, "不触发出发");
  const agent = box.querySelectorAll(".msg.agent");
  ok(agent.length >= 1, "有回复气泡");
  ok(/没理解/.test(agent[agent.length - 1].textContent), "配了 Key 的提示文案");
});

await test("降级：LLM 抛错（401）→ 正则命中「现在出发」", async () => {
  const { sandbox, calls } = buildChatEnv({
    key: "bad",
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "unauth", json: async () => ({}) }),
  });
  await sandbox.dispatchUserText("我现在出发了");
  eq(calls.departForNext, 1, "降级后正则命中");
});

await test("降级：LLM 抛错（500）→ 正则也不命中 → 「网络开小差」文案（非演示模式）", async () => {
  const { sandbox, calls, box } = buildChatEnv({
    key: "bad",
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) }),
  });
  await sandbox.dispatchUserText("你好呀");
  eq(calls.departForNext, 0, "不出发");
  const agent = box.querySelectorAll(".msg.agent");
  ok(agent.length >= 1, "有回复气泡");
  ok(/开小差/.test(agent[agent.length - 1].textContent), "LLM 失败 → 网络开小差文案");
});

await test("降级：无 Key → 不发任何请求，直接正则", async () => {
  const { sandbox, calls } = buildChatEnv({ key: "", fetchImpl: async () => zhipuResp('{"action":"depart_now"}') });
  await sandbox.dispatchUserText("出门了");
  eq(calls.departForNext, 1, "正则命中出发");
  eq(calls.fetch || 0, 0, "未发 LLM 请求");
});

await test("isDepartIntent 正负例（正则兜底仍准确）", () => {
  const { sandbox } = buildChatEnv({ key: "" });
  ok(sandbox.isDepartIntent("我现在出发了"), "出发了");
  ok(sandbox.isDepartIntent("出门咯"), "出门咯");
  ok(!sandbox.isDepartIntent("今天天气怎么样"), "天气无关");
  ok(!sandbox.isDepartIntent("第 2 节改到 15:40"), "课表修改");
});

await test("MODE_LABEL / MODE_CODE 双向映射一致（与 #set-mode 选项对齐）", () => {
  const { sandbox } = buildChatEnv({ key: "" });
  ["walking", "cycling", "transit"].forEach((code) => {
    ok(sandbox.MODE_CODE[sandbox.MODE_LABEL[code]] === code, code + " ↔ " + sandbox.MODE_LABEL[code]);
  });
});

/* ---------------- 汇总 ---------------- */
const pass = results.filter((r) => r.ok).length;
console.log("\n==========================================");
console.log(`结果：${pass} 通过 / ${results.length - pass} 失败`);
console.log("==========================================");
process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
