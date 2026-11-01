/* ===================================================================
   第五步测试：自动推送 + 防重复 + 「现在出发」（vm + 迷你 DOM，无浏览器）
   运行：node test/step5-autopush.test.js
   =================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const CHAT_SRC = fs.readFileSync(path.join(ROOT, "assets/js/chat.js"), "utf8");
const PUSH_SRC = fs.readFileSync(path.join(ROOT, "assets/js/auto-push.js"), "utf8");

const REAL_DATE = Date;
let NOW = new REAL_DATE(2026, 9, 21, 9, 0).getTime(); // 2026-10-21 周三 09:00

class FakeDate extends REAL_DATE {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}

/* ---------------- 迷你 DOM ---------------- */
let DOC_ROOT = null;

class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.className = "";
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._text = "";
    this.value = "";
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get firstElementChild() { return this.children[0] || null; }
  get isConnected() { let n = this; while (n) { if (n === DOC_ROOT) return true; n = n.parentNode; } return false; }
  get scrollHeight() { return 100; }
  set scrollTop(v) { this._scrollTop = v; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i > -1) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = String(v); }
  _all(out) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
  querySelectorAll(sel) { return this._all([]).filter((el) => matchesSel(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let n = this;
    while (n) { if (n.tagName && matchesSel(n, sel)) return n; n = n.parentNode; }
    return null;
  }
  cloneNode(deep) {
    const c = new El(this.tagName);
    c.className = this.className;
    c._text = this._text;
    c.attrs = Object.assign({}, this.attrs);
    if (deep) this.children.forEach((ch) => c.appendChild(ch.cloneNode(true)));
    return c;
  }
}

function matchesSimple(el, p) {
  if (p.charAt(0) === "#") return el.id === p.slice(1);
  if (p === "[id]") return !!el.attrs.id;
  const m = p.match(/^([a-zA-Z]*)((?:[.#][\w-]+)*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const toks = m[2].match(/[.#][\w-]+/g) || [];
  return toks.every((t) =>
    t.charAt(0) === "." ? el.className.split(/\s+/).indexOf(t.slice(1)) > -1 : el.id === t.slice(1));
}

function matchesSel(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  let pi = parts.length - 2;
  let node = el.parentNode;
  while (pi >= 0) {
    while (node && !matchesSimple(node, parts[pi])) node = node.parentNode;
    if (!node) return false;
    pi -= 1;
    node = node.parentNode;
  }
  return true;
}

function commuteRow(label, value, id) {
  const row = new El("div"); row.className = "commute-row";
  const l = new El("span"); l.className = "label"; l.textContent = label;
  const v = new El("span"); v.className = "value"; v.textContent = value;
  if (id) v.id = id;
  row.appendChild(l); row.appendChild(v);
  return row;
}

function buildTemplate() {
  const bubble = new El("div"); bubble.className = "bubble";
  const card = new El("div"); card.className = "commute-card";
  card.appendChild(commuteRow("课程名", "—", "commute-course"));
  card.appendChild(commuteRow("开始时间", "—", "commute-start"));
  card.appendChild(commuteRow("教室位置", "—", "commute-room"));
  card.appendChild(commuteRow("路上耗时", "—", "commute-travel"));
  card.appendChild(commuteRow("天气提醒", "—", "commute-weather"));
  bubble.appendChild(card);
  const btn = new El("button"); btn.className = "btn btn-primary depart-btn"; btn.id = "departNowBtn";
  bubble.appendChild(btn);
  const time = new El("span"); time.className = "time"; time.textContent = "08:30";
  bubble.appendChild(time);
  const msg = new El("div"); msg.className = "msg agent";
  const avatar = new El("div"); avatar.className = "avatar";
  msg.appendChild(avatar); msg.appendChild(bubble);
  const frag = new El("#fragment"); frag.appendChild(msg);
  const tpl = new El("template"); tpl.content = frag;
  return tpl;
}

/* ---------------- 测试环境工厂 ---------------- */
function buildEnv(opts) {
  opts = opts || {};
  if (opts.now) NOW = opts.now;
  const bubbles = [];
  const store = new Map();
  if (opts.preloadState) store.set("campus_autopush_v1", JSON.stringify(opts.preloadState));
  if (opts.semesterStart) store.set("campus_semester_start", opts.semesterStart);

  const messageList = new El("div"); messageList.id = "messageList";
  const chatScroll = new El("div");
  const depart = new El("input"); depart.value = opts.origin || "梅园 3 栋 518";
  const mode = new El("select"); mode.value = opts.mode || "步行";
  const advance = new El("input"); advance.value = String(opts.advance != null ? opts.advance : 10);
  const byId = {
    messageList, chatScroll,
    "set-depart": depart, "set-mode": mode, "set-advance": advance,
    commuteCardTpl: buildTemplate(),
  };
  const listeners = {};
  const document = {
    getElementById: (id) => byId[id] || null,
    createElement: (t) => new El(t),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    visibilityState: "visible",
  };
  DOC_ROOT = document;
  messageList.parentNode = document;

  let rows = opts.rows || [];
  const calls = { detail: 0, weather: 0 };
  const sandbox = {
    Date: FakeDate,
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document,
    setInterval: () => 0,
    clearInterval: () => {},
    ScheduleCore: { getRows: () => rows },
    CommuteAPI: opts.commute || {
      getCommuteDetail: async () => { calls.detail += 1; return { minutes: 15 }; },
      checkWeather: async () => { calls.weather += 1; return { text: "晴 ☀️（测试）" }; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CHAT_SRC, sandbox);
  vm.runInContext(PUSH_SRC, sandbox);
  sandbox.appendAgentText = (t) => bubbles.push(t); // 捕获气泡文本
  if (sandbox.AutoPush && sandbox.AutoPush.setConfirmed) sandbox.AutoPush.setConfirmed(true); // 跳过“课表确认”门控，专测推送逻辑

  return {
    sandbox, bubbles, messageList, listeners, calls, store,
    depart, mode, advance,
    setRows: (r) => { rows = r; },
    setNow: (y, m, d, h, mi) => { NOW = new REAL_DATE(y, m, d, h, mi).getTime(); },
  };
}

/* ---------------- 断言工具 ---------------- */
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; console.log("  ✗ " + name + "\n      " + (e && e.message)); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || "") + " 期望「" + expected + "」，实际「" + actual + "」");
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "断言失败"); }
const tick = () => new Promise((r) => setImmediate(r));

function cardWrappers(env) {
  return env.messageList.children.filter((n) => n.querySelector(".commute-card"));
}
function field(wrap, label) {
  const rows = wrap.querySelectorAll(".commute-row");
  for (const r of rows) {
    const l = r.querySelector(".label");
    if (l && l.textContent === label) return r.querySelector(".value").textContent;
  }
  return null;
}
function courseNames(env) {
  return cardWrappers(env).map((w) => field(w, "课程名"));
}

/* ---------------- 示例课表（每天，无星期标注） ---------------- */
const SAMPLE = [
  { idx: 5, course_name: "体育（篮球）", start_time: "08:00", end_time: "09:40", location: "体育馆 B 区", weeks: "" },
  { idx: 1, course_name: "高等数学（必修）", start_time: "10:00", end_time: "11:40", location: "教三楼 302", weeks: "" },
  { idx: 2, course_name: "大学英语", start_time: "14:00", end_time: "15:40", location: "外语楼 105", weeks: "" },
  { idx: 3, course_name: "程序设计基础", start_time: "16:00", end_time: "17:40", location: "计算机楼 401", weeks: "" },
  { idx: 4, course_name: "线性代数", start_time: "19:00", end_time: "20:40", location: "教二楼 208", weeks: "" },
];

/* =================================================================== */
(async () => {
console.log("\n◆ 模块一：自动推送与防重复");

await test("周三 09:00 → 推送当天后续 4 节课 + 1 条气泡 + 4 张卡片（按时间排序）", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 1, "气泡数");
  ok(/早上好/.test(env.bubbles[0]), "问候语");
  ok(/今天还剩 4 节课/.test(env.bubbles[0]), "课程数文案");
  eq(cardWrappers(env).length, 4, "卡片数");
  eq(courseNames(env).join(","), "高等数学（必修）,大学英语,程序设计基础,线性代数", "卡片顺序");
  await tick();
  eq(field(cardWrappers(env)[0], "路上耗时"), "15 分钟", "实时耗时");
  eq(field(cardWrappers(env)[0], "天气提醒"), "晴 ☀️（测试）", "天气");
});

await test("同时段再次 render → 不新增气泡、不重复建卡（防重复核心）", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  const before = env.store.get("campus_autopush_v1");
  env.sandbox.AutoPush.render();
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 1, "气泡仍为 1");
  eq(cardWrappers(env).length, 4, "卡片仍为 4");
  eq(env.store.get("campus_autopush_v1"), before, "缓存不变");
});

await test("退出重进（localStorage 已记录）→ 无气泡，只保留表格状态", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  const AP = env.sandbox.AutoPush;
  const shown = {};
  ["高等数学（必修）|10:00", "大学英语|14:00", "程序设计基础|16:00", "线性代数|19:00"].forEach((s) => {
    const row = SAMPLE.find((r) => r.course_name + "|" + r.start_time === s);
    shown[AP.keyOf(row, true)] = Date.now();
  });
  const env2 = buildEnv({
    now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE,
    preloadState: { day: "2026-10-21", shown },
  });
  env2.sandbox.AutoPush.render();
  eq(env2.bubbles.length, 0, "不重复输出气泡");
  eq(cardWrappers(env2).length, 4, "表格状态保留（4 张卡）");
});

await test("10:30 重进 → 高数已开始被移除，英语等未开始不重复推送", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  env.setNow(2026, 9, 21, 10, 30);
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 1, "无新气泡");
  eq(cardWrappers(env).length, 3, "已开始的课移除卡片");
  ok(courseNames(env).indexOf("高等数学（必修）") === -1, "高数卡已移除");
});

await test("晚间 19:58 → 追加明天第一节课（明天 08:00 体育）", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 19, 58).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 1, "气泡数");
  ok(/晚上好/.test(env.bubbles[0]), "晚间问候");
  ok(/今天的课都结束了/.test(env.bubbles[0]), "当天剩余为空");
  ok(/明天第一节课是《体育（篮球）》（08:00）/.test(env.bubbles[0]), "次日第一节课");
  eq(cardWrappers(env).length, 1, "仅 1 张卡");
  eq(field(cardWrappers(env)[0], "课程名"), "体育（篮球）");
  eq(field(cardWrappers(env)[0], "开始时间"), "08:00（明天）", "标注明天");
  await tick();
  eq(field(cardWrappers(env)[0], "路上耗时"), "15 分钟", "明天课程也算实时耗时");
});

await test("20:30 再 render → 明天课程不重复推送", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 19, 58).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  env.setNow(2026, 9, 21, 20, 30);
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 1, "无新气泡");
  eq(cardWrappers(env).length, 1, "卡片不变");
});

await test("跨天（周四 08:30）→ 缓存清空，允许重新推送", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  env.setNow(2026, 9, 22, 8, 30); // 周四
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 2, "新的一天重新推送");
  ok(/早上好/.test(env.bubbles[1]), "新的问候");
  eq(cardWrappers(env).length, 4, "4 张卡");
});

await test("周末无课（带星期课表：仅周一有课）→ 周六不推送", async () => {
  const rows = [{ idx: 1, course_name: "周一英语", start_time: "08:00", end_time: "09:40", location: "外语楼 105", weeks: "", day: 1 }];
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 24, 10, 0).getTime(), rows }); // 周六
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 0, "周末无课不推送气泡");
  eq(cardWrappers(env).length, 0, "无卡片");
});

await test("周六 20:00（明天周日仍无课）→ 不推送", async () => {
  const rows = [{ idx: 1, course_name: "周一英语", start_time: "08:00", end_time: "09:40", location: "外语楼 105", weeks: "", day: 1 }];
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 24, 20, 0).getTime(), rows });
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 0, "不推送");
  eq(cardWrappers(env).length, 0, "无卡片");
});

await test("周日 20:00 → 推下周一第一节课（跨周）", async () => {
  const rows = [{ idx: 1, course_name: "周一英语", start_time: "08:00", end_time: "09:40", location: "外语楼 105", weeks: "", day: 1 }];
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 25, 20, 0).getTime(), rows }); // 周日
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 1, "周日晚推送下周一");
  ok(/明天第一节课是《周一英语》（08:00）/.test(env.bubbles[0]), "下周一第一节课");
  eq(cardWrappers(env).length, 1, "1 张卡");
});

await test("星期解析：数字/中文/英文均可，未标注=每天", async () => {
  const env = buildEnv({ rows: SAMPLE });
  const AP = env.sandbox.AutoPush;
  const base = { weeks: "" };
  eq(AP.matchesDay({ day: 1 }, new REAL_DATE(2026, 9, 26)), true, "day=1 匹配周一");
  eq(AP.matchesDay({ day: 1 }, new REAL_DATE(2026, 9, 25)), false, "day=1 不匹配周日");
  eq(AP.matchesDay({ day: 7 }, new REAL_DATE(2026, 9, 25)), true, "day=7 = 周日");
  eq(AP.matchesDay({ day: 0 }, new REAL_DATE(2026, 9, 25)), true, "day=0 = 周日");
  eq(AP.matchesDay({ weekday: "周三" }, new REAL_DATE(2026, 9, 21)), true, "周三中文");
  eq(AP.matchesDay({ weekday: "wed" }, new REAL_DATE(2026, 9, 21)), true, "wed 英文");
  eq(AP.matchesDay({ weekday: "星期五" }, new REAL_DATE(2026, 9, 23)), true, "星期五");
  eq(AP.matchesDay({}, new REAL_DATE(2026, 9, 25)), true, "未标注=每天");
});

await test("周次匹配：1-16 / 单周 / 双周 / 列表 / 无学期起点", async () => {
  const env = buildEnv({ rows: SAMPLE, semesterStart: "2026-09-07" }); // 第1周周一
  const AP = env.sandbox.AutoPush;
  const d = (y, m, day) => new REAL_DATE(y, m, day);
  eq(AP.weekMatches("", d(2026, 9, 25)), true, "空 weeks");
  eq(AP.weekMatches("1-16", d(2026, 9, 26)), true, "第8周在 1-16");
  eq(AP.weekMatches("1-16", d(2026, 11, 28)), false, "第17周不在 1-16");
  eq(AP.weekMatches("单周", d(2026, 9, 25)), true, "第7周=单周");
  eq(AP.weekMatches("单周", d(2026, 9, 26)), false, "第8周≠单周");
  eq(AP.weekMatches("双周", d(2026, 9, 26)), true, "第8周=双周");
  eq(AP.weekMatches("1-8,10-16", d(2026, 9, 26)), true, "第8周在列表");
  eq(AP.weekMatches("1-8,10-16", d(2026, 10, 2)), false, "第9周不在列表");
  eq(AP.weekMatches("1-8,10-16", d(2026, 10, 9)), true, "第10周在列表");
  const env2 = buildEnv({ rows: SAMPLE }); // 无学期起点
  eq(env2.sandbox.AutoPush.weekMatches("单周", d(2026, 9, 26)), true, "无学期起点不过滤");
});

await test("跨周：单周课在周日（第7周）→ 明天周一（第8周）不推", async () => {
  const rows = [{ idx: 1, course_name: "单周高数", start_time: "08:00", end_time: "09:40", location: "教三楼 302", weeks: "单周", day: 1 }];
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 25, 20, 0).getTime(), rows, semesterStart: "2026-09-07" });
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 0, "明天是双周，单周课不推送");
  eq(cardWrappers(env).length, 0, "无卡片");
});

console.log("\n◆ 模块二：现在出发");

await test("点击/自然语言 → 今天的课：预计到达 + 多余时间", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  await tick();
  env.sandbox.AutoPush.departForNext();
  eq(env.bubbles[env.bubbles.length - 1],
    "路上注意安全，预计 09:15 到达，比上课提前 45 分钟，时间充裕。", "到达/多余时间");
});

await test("路上 58 分钟 → 刚好赶得上；70 分钟 → 已晚于上课时间", async () => {
  const mk = (min) => buildEnv({
    now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE,
    commute: {
      getCommuteDetail: async () => ({ minutes: min }),
      checkWeather: async () => ({ text: "晴" }),
    },
  });
  const e1 = mk(58); e1.sandbox.AutoPush.render(); await tick();
  e1.sandbox.AutoPush.departForNext();
  ok(/预计 09:58 到达，比上课提前 2 分钟，刚好赶得上。/.test(e1.bubbles[e1.bubbles.length - 1]), "刚好赶得上");
  const e2 = mk(70); e2.sandbox.AutoPush.render(); await tick();
  e2.sandbox.AutoPush.departForNext();
  ok(/预计 10:10 到达，已晚于上课时间 10 分钟，快走！/.test(e2.bubbles[e2.bubbles.length - 1]), "已迟到");
});

await test("明天的课 → 给出建议出发时间（不预留提前量）", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 19, 58).getTime(), rows: SAMPLE, advance: 10 });
  env.sandbox.AutoPush.render();
  await tick();
  env.sandbox.AutoPush.departForNext();
  eq(env.bubbles[env.bubbles.length - 1],
    "《体育（篮球）》明天 08:00 开始，路上约 15 分钟，建议明天 07:45 出发。", "明天建议");
});

await test("建议出发时间不再含“提前 N 分钟到课”", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 19, 58).getTime(), rows: SAMPLE, advance: 20 });
  env.sandbox.AutoPush.render();
  await tick();
  env.sandbox.AutoPush.departForNext();
  const m = env.bubbles[env.bubbles.length - 1];
  ok(/建议明天 07:45 出发。/.test(m), "出发时间固定=上课-路上耗时");
  ok(!/提前.*分钟到课/.test(m), "不再出现提前到课文案");
});

await test("实时耗时计算中 → 提示稍候，不用半成品数据", async () => {
  const env = buildEnv({
    now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE,
    commute: { getCommuteDetail: () => new Promise(() => {}), checkWeather: () => new Promise(() => {}) },
  });
  env.sandbox.AutoPush.render();
  eq(field(cardWrappers(env)[0], "路上耗时"), "计算中…", "占位");
  env.sandbox.AutoPush.departForNext();
  ok(/正在为你计算实时通勤时间/.test(env.bubbles[env.bubbles.length - 1]), "稍候提示");
});

await test("无待通勤课程 → 友好提示", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 23, 0).getTime(), rows: [] });
  env.sandbox.AutoPush.departForNext();
  eq(env.bubbles[env.bubbles.length - 1], "今天没有需要通勤的课程啦，好好休息～", "空课表提示");
});

await test("卡片按钮点击（事件委托）→ 触发现在出发", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  await tick();
  const btn = cardWrappers(env)[0].querySelector(".depart-btn");
  (env.listeners.click || []).forEach((fn) => fn({ target: btn }));
  ok(/路上注意安全，预计 09:15 到达/.test(env.bubbles[env.bubbles.length - 1]), "委托触发");
});

await test("意图识别：现在出发/出门了/出发吧 → true；课表修改/闲聊 → false", async () => {
  const env = buildEnv({ rows: SAMPLE });
  const isDepart = env.sandbox.isDepartIntent;
  ["我现在出发了", "出门了", "出发吧", "准备出发", "该走了", "走吧", "马上出发"].forEach((t) =>
    ok(isDepart(t), "应识别：「" + t + "」"));
  ["今天有课吗", "第 2 节结束时间改成 15:40", "天气怎么样", "你好"].forEach((t) =>
    ok(!isDepart(t), "不应识别：「" + t + "」"));
});

console.log("\n◆ 数据流与降级");

await test("API 失败 → 耗时/天气各自回退演示值，互不阻塞", async () => {
  const env = buildEnv({
    now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE,
    commute: {
      getCommuteDetail: async () => { throw new Error("OVER_DIRECTION_RANGE"); },
      checkWeather: async () => { throw new Error("403"); },
    },
  });
  env.sandbox.AutoPush.render();
  await tick();
  eq(field(cardWrappers(env)[0], "路上耗时"), "12 分钟", "耗时回退演示值");
  ok(/晴/.test(field(cardWrappers(env)[0], "天气提醒")), "天气回退演示值");
});

await test("耗时成功/天气失败 → 只回退天气部分", async () => {
  const env = buildEnv({
    now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE,
    commute: {
      getCommuteDetail: async () => ({ minutes: 8 }),
      checkWeather: async () => { throw new Error("403"); },
    },
  });
  env.sandbox.AutoPush.render();
  await tick();
  eq(field(cardWrappers(env)[0], "路上耗时"), "8 分钟", "真实耗时");
  ok(/晴 ☀️/.test(field(cardWrappers(env)[0], "天气提醒")), "天气回退");
});

await test("改课表时间 → 换卡不重复推送（silent）", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  const edited = SAMPLE.map((r) => (r.idx === 2 ? Object.assign({}, r, { start_time: "15:00" }) : r));
  env.setRows(edited);
  env.sandbox.AutoPush.render({ silent: true });
  eq(env.bubbles.length, 1, "静默刷新不推送气泡");
  eq(cardWrappers(env).length, 4, "卡片总数不变");
  const en = cardWrappers(env).filter((w) => field(w, "课程名") === "大学英语");
  eq(en.length, 1, "大学英语只有一张卡（旧卡已移除）");
  eq(field(en[0], "开始时间"), "15:00", "开始时间已更新");
});

await test("recompute：出发地变化 → 重新计算所有卡片实时数据", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  await tick();
  eq(env.calls.detail, 4, "首次 4 个教室 4 次耗时计算");
  eq(env.calls.weather, 1, "天气按出发地只查 1 次");
  env.depart.value = "新宿舍楼 6 栋";
  env.sandbox.AutoPush.render({ recompute: true });
  await tick();
  eq(env.calls.detail, 8, "出发地变了全部重算");
  eq(env.calls.weather, 2, "天气也重查");
});

await test("卡片克隆会剥掉模板 id（多张卡片不冲突）", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  cardWrappers(env).forEach((w) => eq(w.querySelectorAll("[id]").length, 0, "克隆卡片无 id"));
});

await test("state 落库：推送记录写入 localStorage", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE });
  env.sandbox.AutoPush.render();
  const st = JSON.parse(env.store.get("campus_autopush_v1"));
  eq(st.day, "2026-10-21", "日期桶");
  eq(Object.keys(st.shown).length, 4, "记录 4 门课");
  ok(Object.keys(st.shown)[0].indexOf("today|") === 0, "key 带 today 前缀");
});

console.log("\n=========================================");
console.log("结果：" + passed + " 通过 / " + failed + " 失败");
console.log("=========================================\n");
process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
