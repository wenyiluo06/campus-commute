/* ===================================================================
   第六步测试：单双周 / 起止周次 / 学期起点（vm + 迷你 DOM，无浏览器）
   运行：node test/step6-weeks.test.js
   覆盖：
     - ScheduleCore.parseWeeks / normalize / formatWeeks / parseEdit（周次自然语言）
     - 核对表新增「周次 / 单双周」列 + 改动互相同步 + persist 落库字段
     - AutoPush：结构化周次匹配、学期起点注入、跨周判断、气泡带当前周数
     - chat.js：设置表单 / 快照 / 回填（semester_start）
     - supabase.js：saveSettings（空日期→NULL）/ saveSchedule（结构化周次字段）
   =================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const CORE_SRC = fs.readFileSync(path.join(ROOT, "assets/js/schedule-core.js"), "utf8");
const CHAT_SRC = fs.readFileSync(path.join(ROOT, "assets/js/chat.js"), "utf8");
const PUSH_SRC = fs.readFileSync(path.join(ROOT, "assets/js/auto-push.js"), "utf8");
const SUPA_SRC = fs.readFileSync(path.join(ROOT, "assets/js/supabase.js"), "utf8");

const REAL_DATE = Date;
let NOW = new REAL_DATE(2026, 9, 21, 9, 0).getTime(); // 2026-10-21 周三 09:00

class FakeDate extends REAL_DATE {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}

/* ---------------- 迷你 DOM（含 innerHTML 解析 / select / dataset） ---------------- */
let DOC_ROOT = null;
const VOID_TAGS = { input: 1, br: 1, img: 1, hr: 1, meta: 1, link: 1, source: 1 };

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
}

function parseHTML(root, html) {
  const stack = [root];
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      const el = new El(tag);
      const attrRe = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let am;
      while ((am = attrRe.exec(m[3] || ""))) {
        el.attrs[am[1]] = decodeEntities(am[2] != null ? am[2] : (am[3] != null ? am[3] : (am[4] != null ? am[4] : "")));
      }
      stack[stack.length - 1].appendChild(el);
      if (el.attrs.class !== undefined) el.className = el.attrs.class;
      if (el.attrs.value !== undefined) el._value = el.attrs.value;
      if (el.attrs.selected !== undefined) el._selected = true;
      if (el.attrs.checked !== undefined) el._checked = true;
      if (!VOID_TAGS[tag] && m[4] !== "/") stack.push(el);
      continue;
    }
    if (m[5] != null) {
      const txt = decodeEntities(m[5]);
      if (txt.trim()) stack[stack.length - 1]._text += txt;
    }
  }
}

class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.className = "";
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this._value = "";
    this._checked = false;
    this._selected = false;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get firstElementChild() { return this.children[0] || null; }
  get isConnected() { let n = this; while (n) { if (n === DOC_ROOT) return true; n = n.parentNode; } return false; }
  get scrollHeight() { return 100; }
  set scrollTop(v) { this._scrollTop = v; }
  get dataset() {
    const d = {};
    Object.keys(this.attrs).forEach((k) => {
      if (k.indexOf("data-") === 0) {
        d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this.attrs[k];
      }
    });
    return d;
  }
  get options() { return this.children.filter((c) => c.tagName === "OPTION"); }
  get selected() { return this._selected; }
  set selected(v) { this._selected = !!v; }
  get checked() { return this._checked; }
  set checked(v) { this._checked = !!v; }
  get value() {
    if (this.tagName === "SELECT") {
      const sel = this.options.find((o) => o._selected);
      if (sel) return sel.value;
      return this.options[0] ? this.options[0].value : "";
    }
    if (this.tagName === "OPTION") return this._value || this._text;
    return this._value;
  }
  set value(v) {
    const s = String(v);
    if (this.tagName === "SELECT") {
      this.options.forEach((o) => { o._selected = o.value === s; });
      if (!this.options.some((o) => o._selected) && this.options[0]) this.options[0]._selected = true;
      return;
    }
    this._value = s;
  }
  get innerHTML() { return this._html || ""; }
  set innerHTML(html) { this._html = String(html); this.children = []; parseHTML(this, this._html); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev || {})); }
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
    c._value = this._value;
    c._checked = this._checked;
    c._selected = this._selected;
    c.attrs = Object.assign({}, this.attrs);
    if (deep) this.children.forEach((ch) => c.appendChild(ch.cloneNode(true)));
    return c;
  }
}

function matchesSimple(el, p) {
  const m = p.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const toks = m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || [];
  return toks.every((t) => {
    if (t.charAt(0) === ".") return el.className.split(/\s+/).indexOf(t.slice(1)) > -1;
    if (t.charAt(0) === "#") return el.id === t.slice(1);
    const am = t.match(/^\[([\w:-]+)(?:="([^"]*)")?\]$/);
    if (!am) return false;
    if (am[1] === "id") return am[2] === undefined ? !!el.attrs.id : el.attrs.id === am[2];
    const v = el.attrs[am[1]];
    return am[2] === undefined ? v !== undefined : v === am[2];
  });
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
  const mode = new El("select");
  mode.innerHTML = '<option value="步行">步行</option><option value="骑行">骑行</option><option value="校内公交">校内公交</option>';
  mode.value = opts.mode || "步行";
  const advance = new El("input"); advance.value = String(opts.advance != null ? opts.advance : 10);
  const school = new El("input"); school.value = opts.school || "测试大学";
  const semester = new El("input"); semester.value = opts.semester || "";
  const weather = new El("input"); weather.checked = true;
  const notify = new El("input"); notify.checked = true;
  const byId = {
    messageList, chatScroll,
    "set-depart": depart, "set-mode": mode, "set-advance": advance,
    "set-school": school, "set-semester": semester, "set-weather": weather, "set-notify": notify,
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
    ScheduleCore: null, // 由下方真实脚本填充
    CommuteAPI: opts.commute || {
      getCommuteDetail: async () => { calls.detail += 1; return { minutes: 15 }; },
      checkWeather: async () => { calls.weather += 1; return { text: "晴 ☀️（测试）" }; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CORE_SRC, sandbox);  // 真实 ScheduleCore（含 parseWeeks）
  sandbox.ScheduleCore.setRows(rows, "test");
  rows = sandbox.ScheduleCore.getRows();
  vm.runInContext(CHAT_SRC, sandbox);
  vm.runInContext(PUSH_SRC, sandbox);
  sandbox.appendAgentText = (t) => bubbles.push(t);
  if (sandbox.AutoPush && sandbox.AutoPush.setConfirmed) sandbox.AutoPush.setConfirmed(true); // 跳过“课表确认”门控，专测推送逻辑

  return {
    sandbox, bubbles, messageList, listeners, calls, store,
    depart, mode, advance, school, semester,
    setRows: (r) => { sandbox.ScheduleCore.setRows(r, "test"); rows = sandbox.ScheduleCore.getRows(); },
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
  if (actual !== expected) throw new Error((msg || "") + " 期望「" + expected + "」，实际「" + actual + "」");
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
function courseNames(env) { return cardWrappers(env).map((w) => field(w, "课程名")); }

/* ---------------- 示例课表 ---------------- */
const SAMPLE = [
  { idx: 5, course_name: "体育（篮球）", start_time: "08:00", end_time: "09:40", location: "体育馆 B 区", weeks: "1-8", start_week: 1, end_week: 8, week_type: "all" },
  { idx: 1, course_name: "高等数学（必修）", start_time: "10:00", end_time: "11:40", location: "教三楼 302", weeks: "1-16", start_week: 1, end_week: 16, week_type: "all" },
  { idx: 2, course_name: "大学英语", start_time: "14:00", end_time: "15:40", location: "外语楼 105", weeks: "1-16 单周", start_week: 1, end_week: 16, week_type: "odd" },
  { idx: 3, course_name: "程序设计基础", start_time: "16:00", end_time: "17:40", location: "计算机楼 401", weeks: "2-15", start_week: 2, end_week: 15, week_type: "all" },
  { idx: 4, course_name: "线性代数", start_time: "19:00", end_time: "20:40", location: "教二楼 208", weeks: "1-16", start_week: 1, end_week: 16, week_type: "all" },
];

/* =================================================================== */
(async () => {
console.log("\n◆ 周次解析与归一化（ScheduleCore）");

await test("parseWeeks：1-16 / 单周 / 双周 / 1-8,10-16 / 3 / 空 / 第1-16周", async () => {
  const SC = buildEnv({ rows: [] }).sandbox.ScheduleCore;
  let p = SC.parseWeeks("1-16");
  eq(p.start, 1, "1-16 start"); eq(p.end, 16, "1-16 end"); eq(p.type, "all", "1-16 type"); ok(p.hasRange, "hasRange");
  p = SC.parseWeeks("单周");
  eq(p.type, "odd", "单周"); eq(p.start, null, "单周无数字"); ok(p.hasParity, "hasParity");
  p = SC.parseWeeks("双周");
  eq(p.type, "even", "双周");
  p = SC.parseWeeks("1-8,10-16");
  eq(p.start, 1, "列表 min"); eq(p.end, 16, "列表 max");
  p = SC.parseWeeks("3");
  eq(p.start, 3, "单周数字"); eq(p.end, 3, "单周数字 end");
  p = SC.parseWeeks("");
  eq(p.type, "all", "空"); eq(p.start, null, "空 start"); ok(!p.hasRange && !p.hasParity, "空无信息");
  p = SC.parseWeeks("第1-16周");
  eq(p.start, 1, "第N周"); eq(p.end, 16, "第N周 end");
});

await test("normalize：结构化字段缺失时从 weeks 文本反推", async () => {
  const env = buildEnv({ rows: [
    { idx: 1, course_name: "A", start_time: "08:00", weeks: "2-15" },
    { idx: 2, course_name: "B", start_time: "09:00", weeks: "单周" },
    { idx: 3, course_name: "C", start_time: "10:00", weeks: "" },
    { idx: 4, course_name: "D", start_time: "11:00", weeks: "1-8", week_type: "even" },
  ] });
  const rows = env.sandbox.ScheduleCore.getRows();
  eq(rows[0].start_week, 2, "A 起始周"); eq(rows[0].end_week, 15, "A 结束周"); eq(rows[0].week_type, "all", "A 每周");
  eq(rows[1].week_type, "odd", "B 单周"); eq(rows[1].start_week, null, "B 无起始周");
  eq(rows[2].week_type, "all", "C 默认每周"); eq(rows[2].start_week, null, "C 无起始周");
  eq(rows[3].week_type, "even", "D 显式双周优先于文本");
});

await test("formatWeeks：展示文案（结构化优先，文本兜底）", async () => {
  const SC = buildEnv({ rows: [] }).sandbox.ScheduleCore;
  eq(SC.formatWeeks({ weeks: "1-16", start_week: 1, end_week: 16, week_type: "all" }), "第 1-16 周", "全期");
  eq(SC.formatWeeks({ weeks: "1-16 单周", start_week: 1, end_week: 16, week_type: "odd" }), "第 1-16 周 · 单周", "单周");
  eq(SC.formatWeeks({ weeks: "3", start_week: 3, end_week: 3, week_type: "all" }), "第 3 周", "单周次");
  eq(SC.formatWeeks({ weeks: "双周", week_type: "even" }), "双周", "仅双周");
  eq(SC.formatWeeks({ weeks: "", week_type: "all" }), "每周", "无信息");
});

console.log("\n◆ 核对表：周次 / 单双周列");

await test("核对表含「周次」「单双周」表头与对应输入控件", async () => {
  const env = buildEnv({ rows: SAMPLE });
  const card = env.sandbox.ScheduleCore.renderVerifyCard({ rows: SAMPLE });
  const ths = card.querySelectorAll(".verify-table th").map((t) => t.textContent);
  eq(ths.join(","), "节,课程,开始,结束,教室,周次,单双周", "表头");
  const weeksInput = card.querySelector('.vc-input[data-field="weeks"][data-idx="2"]');
  ok(weeksInput, "周次输入框存在");
  eq(weeksInput.value, "1-16 单周", "大学英语周次文本");
  const sel = card.querySelector('.vc-input[data-field="week_type"][data-idx="2"]');
  ok(sel && sel.tagName === "SELECT", "单双周下拉存在");
  eq(sel.value, "odd", "下拉选中单周");
  eq(card.querySelector('.vc-input[data-field="week_type"][data-idx="1"]').value, "all", "高数=每周");
  eq(card.querySelector('.vc-input[data-field="weeks"][data-idx="3"]').value, "2-15", "程设 2-15");
});

await test("改「周次」文本 → 同步结构化字段并落库（persist=1）", async () => {
  const env = buildEnv({ rows: SAMPLE });
  let saved = null;
  env.sandbox.AppData = { saveSchedule: async (r) => { saved = r; } };
  const card = env.sandbox.ScheduleCore.renderVerifyCard({ rows: env.sandbox.ScheduleCore.getRows(), persist: true });
  env.messageList.appendChild(card);
  const inp = card.querySelector('.vc-input[data-field="weeks"][data-idx="3"]');
  inp.value = "3-12";
  (env.listeners.change || []).forEach((fn) => fn({ target: inp }));
  const row = env.sandbox.ScheduleCore.getRows().find((r) => r.idx === 3);
  eq(row.weeks, "3-12", "文本已改");
  eq(row.start_week, 3, "起始周同步"); eq(row.end_week, 12, "结束周同步");
  ok(saved, "已触发落库");
  const savedRow = saved.find((r) => r.idx === 3);
  eq(savedRow.start_week, 3, "入库起始周"); eq(savedRow.end_week, 12, "入库结束周");
});

await test("改「单双周」下拉 → week_type 生效且清掉文本里的单/双字样", async () => {
  const env = buildEnv({ rows: SAMPLE });
  const card = env.sandbox.ScheduleCore.renderVerifyCard({ rows: env.sandbox.ScheduleCore.getRows(), persist: false });
  const sel = card.querySelector('.vc-input[data-field="week_type"][data-idx="2"]');
  sel.value = "even";
  (env.listeners.change || []).forEach((fn) => fn({ target: sel }));
  const row = env.sandbox.ScheduleCore.getRows().find((r) => r.idx === 2);
  eq(row.week_type, "even", "改成双周");
  eq(row.weeks, "1-16", "文本去掉「单周」");
  const sel2 = card.querySelector('.vc-input[data-field="week_type"][data-idx="2"]');
  eq(sel2.value, "even", "下拉回显双周");
});

await test("自然语言改周次：「第 2 节周次改成 1-8」「第 2 节改成单周」", async () => {
  const env = buildEnv({ rows: SAMPLE });
  const SC = env.sandbox.ScheduleCore;
  let res = SC.parseEdit("第 2 节周次改成 1-8");
  ok(res && res.ok, "周次修改成功");
  let row = SC.getRows().find((r) => r.idx === 2);
  eq(row.weeks, "1-8", "文本"); eq(row.start_week, 1, "起始"); eq(row.end_week, 8, "结束");
  res = SC.parseEdit("第 2 节改成单周");
  ok(res && res.ok, "单周修改成功");
  row = SC.getRows().find((r) => r.idx === 2);
  eq(row.week_type, "odd", "单周"); eq(row.weeks, "1-8", "文本保持");
  res = SC.parseEdit("第 2 节改成每周");
  eq(SC.getRows().find((r) => r.idx === 2).week_type, "all", "改回每周");
});

console.log("\n◆ 结构化周次匹配（AutoPush）");

await test("weekMatches：起止周次（结构化字段优先于 weeks 文本）", async () => {
  const env = buildEnv({ rows: SAMPLE, semesterStart: "2026-09-07" });
  const AP = env.sandbox.AutoPush;
  const row = { weeks: "1-16", start_week: 2, end_week: 8, week_type: "all" };
  eq(AP.weekMatches(row.weeks, new REAL_DATE(2026, 8, 12), row), false, "第1周（09-12）< 起始周2");
  eq(AP.weekMatches(row.weeks, new REAL_DATE(2026, 8, 14), row), true, "第2周（09-14）");
  eq(AP.weekMatches(row.weeks, new REAL_DATE(2026, 9, 26), row), true, "第8周（10-26）");
  eq(AP.weekMatches(row.weeks, new REAL_DATE(2026, 10, 2), row), false, "第9周（11-02）> 结束周8");
});

await test("weekMatches：单周 / 双周（结构化 + 文本两种来源）", async () => {
  const env = buildEnv({ rows: SAMPLE, semesterStart: "2026-09-07" });
  const AP = env.sandbox.AutoPush;
  const oddRow = { weeks: "1-16 单周", start_week: 1, end_week: 16, week_type: "odd" };
  const evenRow = { weeks: "1-16", start_week: 1, end_week: 16, week_type: "even" };
  eq(AP.weekMatches(oddRow.weeks, new REAL_DATE(2026, 9, 25), oddRow), true, "第7周=单周");
  eq(AP.weekMatches(oddRow.weeks, new REAL_DATE(2026, 9, 26), oddRow), false, "第8周≠单周");
  eq(AP.weekMatches(evenRow.weeks, new REAL_DATE(2026, 9, 26), evenRow), true, "第8周=双周");
  // 无结构化字段 → 退回文本解析
  eq(AP.weekMatches("单周", new REAL_DATE(2026, 9, 25)), true, "文本单周·第7周");
  eq(AP.weekMatches("单周", new REAL_DATE(2026, 9, 26)), false, "文本单周·第8周");
  eq(AP.weekMatches("1-8,10-16", new REAL_DATE(2026, 9, 26)), true, "文本列表·第8周");
  eq(AP.weekMatches("1-8,10-16", new REAL_DATE(2026, 10, 2)), false, "文本列表·第9周跳过");
  eq(AP.weekMatches("", new REAL_DATE(2026, 10, 2)), true, "无周信息=每周");
});

await test("semesterWeek / currentWeek：按学期起点换算；setSemesterStart 运行时注入优先", async () => {
  const env = buildEnv({ rows: SAMPLE, semesterStart: "2026-09-07" });
  const AP = env.sandbox.AutoPush;
  eq(AP.semesterWeek(new REAL_DATE(2026, 8, 7)), 1, "第1周周一（09-07）");
  eq(AP.semesterWeek(new REAL_DATE(2026, 9, 21)), 7, "第7周周三（10-21）");
  eq(AP.semesterWeek(new REAL_DATE(2026, 7, 21)), null, "学期开始前（08-21）");
  eq(AP.currentWeek(new REAL_DATE(2026, 9, 21)), 7, "currentWeek");
  // 运行时注入覆盖 localStorage
  AP.setSemesterStart("2026-02-23");
  eq(AP.semesterWeek(new REAL_DATE(2026, 9, 21)), 35, "按新学期起点=第35周");
  eq(env.store.get("campus_semester_start"), "2026-02-23", "已同步 localStorage 兜底");
  AP.setSemesterStart(""); // 清空 → localStorage 兜底也被清掉
  eq(AP.semesterWeek(new REAL_DATE(2026, 9, 21)), null, "无学期起点→null");
});

console.log("\n◆ 自动推送：按周过滤 + 跨周 + 气泡带周数");

await test("设了学期起点 → 推送气泡带「本学期第 N 周」", async () => {
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 21, 9, 0).getTime(), rows: SAMPLE, semesterStart: "2026-09-07" });
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 1, "气泡数");
  ok(/本学期第 7 周/.test(env.bubbles[0]), "当前周数");
  ok(/今天还剩 4 节课/.test(env.bubbles[0]), "课程数");
  eq(courseNames(env).join(","), "高等数学（必修）,大学英语,程序设计基础,线性代数", "卡片顺序");
});

await test("第 8 周（双周）→ 单周的大学英语不推送", async () => {
  // 2026-10-26 是第 8 周周一
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 26, 9, 0).getTime(), rows: SAMPLE, semesterStart: "2026-09-07" });
  env.sandbox.AutoPush.render();
  ok(courseNames(env).indexOf("大学英语") === -1, "单周课本周不上");
  ok(courseNames(env).indexOf("高等数学（必修）") > -1, "每周课仍推送");
});

await test("周日 20:00 跨周：单周课（明天第8周=双周）不推送", async () => {
  const rows = [{ idx: 1, course_name: "单周高数", start_time: "08:00", end_time: "09:40", location: "教三楼 302", weeks: "1-16 单周", start_week: 1, end_week: 16, week_type: "odd", day: 1 }];
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 25, 20, 0).getTime(), rows, semesterStart: "2026-09-07" });
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 0, "明天是双周，不推送");
  eq(cardWrappers(env).length, 0, "无卡片");
});

await test("周日 20:00 跨周：双周课（明天第8周）推送且提示进入新周", async () => {
  const rows = [{ idx: 1, course_name: "双周英语", start_time: "08:00", end_time: "09:40", location: "外语楼 105", weeks: "1-16 双周", start_week: 1, end_week: 16, week_type: "even", day: 1 }];
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 25, 20, 0).getTime(), rows, semesterStart: "2026-09-07" });
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 1, "推送下周一");
  ok(/明天第一节课是《双周英语》（08:00）/.test(env.bubbles[0]), "课程文案");
  ok(/进入第 8 周/.test(env.bubbles[0]), "跨周提示");
  eq(cardWrappers(env).length, 1, "1 张卡");
});

await test("周日 20:00：起止周次外的课不推送（结构化 start_week=9）", async () => {
  const rows = [{ idx: 1, course_name: "第九周起的课", start_time: "08:00", end_time: "09:40", location: "教三楼 302", weeks: "9-16", start_week: 9, end_week: 16, week_type: "all", day: 1 }];
  const env = buildEnv({ now: new REAL_DATE(2026, 9, 25, 20, 0).getTime(), rows, semesterStart: "2026-09-07" });
  env.sandbox.AutoPush.render();
  eq(env.bubbles.length, 0, "明天第8周 < 起始周9，不推送");
});

await test("体育只到第 8 周：第 9 周起消失", async () => {
  // 2026-11-02（周一）是第 9 周
  const env = buildEnv({ now: new REAL_DATE(2026, 10, 2, 9, 0).getTime(), rows: SAMPLE, semesterStart: "2026-09-07" });
  env.sandbox.AutoPush.render();
  ok(courseNames(env).indexOf("体育（篮球）") === -1, "第9周体育已结束");
  ok(courseNames(env).indexOf("高等数学（必修）") > -1, "高数仍在");
});

console.log("\n◆ 设置链路（chat.js：表单 / 回填 / 快照）");

await test("readSettingsForm / fillSettingsForm / snapshot：semester_start 全链路", async () => {
  const env = buildEnv({ rows: SAMPLE });
  const s = {
    school: "清华大学", semester_start: "2026-02-23", default_departure: "紫荆公寓 1 栋",
    commute_mode: "步行", weather_on: true, notify_on: true,
  };
  env.sandbox.fillSettingsForm(s);
  eq(env.school.value, "清华大学", "回填学校");
  eq(env.semester.value, "2026-02-23", "回填学期起点");
  eq(env.depart.value, "紫荆公寓 1 栋", "回填出发地");
  const snap = env.sandbox.snapshotFromSettings(s);
  eq(snap.semester_start, "2026-02-23", "快照含学期起点");
  // 表单回填后应与快照逐字段一致（局部更新脏检测的基础）
  const form = env.sandbox.readSettingsForm();
  Object.keys(snap).forEach((k) => eq(String(form[k]), String(snap[k]), "字段一致：" + k));
  ok(env.sandbox.settingsBasicDirty(), "快照为 null（云端无设置）→ 视为待保存");
});

await test("非法日期输入 → readSettingsForm 归一为空串", async () => {
  const env = buildEnv({ rows: SAMPLE });
  env.semester.value = "abc";
  eq(env.sandbox.readSettingsForm().semester_start, "", "非法值归一化");
});

console.log("\n◆ 入库字段（supabase.js）");

await test("saveSettings：semester_start 空串 → NULL；合法日期原样写入", async () => {
  const state = { upserts: [], settingsRows: [] };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    from() {
      const t = {
        select: () => t, order: () => t,
        limit: async () => ({ data: state.settingsRows, error: null }),
        upsert: async (p) => { state.upserts.push(p); return { error: null }; },
        update: () => ({ eq: async () => ({ error: null }) }),
        insert: async () => ({ error: null }),
        delete: () => ({ neq: () => ({ error: null }) }),
      };
      return t;
    },
  };
  const document = { getElementById: () => null, addEventListener: () => {} };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document,
    SUPABASE_CONFIG: { url: "https://x.supabase.co", anonKey: "k" },
    supabase: { createClient: () => client },
    ScheduleCore: { parseWeeks: (s) => ({ start: null, end: null, type: "all", hasParity: false }), normWeekType: (v) => v || null },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SUPA_SRC, sandbox);

  await sandbox.AppData.saveSettings({ school: "北京大学", semester_start: "", default_departure: "宿舍" });
  eq(state.upserts[0].semester_start, null, "空串→NULL（DATE 列不接受空串）");
  eq(state.upserts[0].school, "北京大学", "学校写入");
  await sandbox.AppData.saveSettings({ school: "北京大学", semester_start: "2026-09-07" });
  eq(state.upserts[1].semester_start, "2026-09-07", "合法日期写入");
  eq(state.upserts[1].default_departure, undefined, "未提供的列不写（局部更新）");
});

await test("saveSchedule：写入 start_week / end_week / week_type（文本解析兜底）", async () => {
  const state = { inserts: [] };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: "u1" } } } }) },
    from() {
      const t = {
        select: () => t, order: () => t,
        upsert: async () => ({ error: null }),
        delete: () => ({ neq: () => ({ error: null }) }),
        insert: async (p) => { state.inserts.push(p); return { error: null }; },
      };
      return t;
    },
  };
  const document = { getElementById: () => null, addEventListener: () => {} };
  const env = buildEnv({ rows: [] }); // 拿真实 ScheduleCore 的 parseWeeks
  const sandbox = {
    Date: FakeDate,
    console: { log() {}, warn() {}, error() {} },
    document,
    SUPABASE_CONFIG: { url: "https://x.supabase.co", anonKey: "k" },
    supabase: { createClient: () => client },
    ScheduleCore: env.sandbox.ScheduleCore,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SUPA_SRC, sandbox);

  await sandbox.AppData.saveSchedule([
    { idx: 1, course_name: "大学英语", start_time: "14:00", end_time: "15:40", location: "外语楼 105", weeks: "1-16 单周" },
    { idx: 2, course_name: "体育", start_time: "08:00", end_time: "09:40", location: "体育馆", weeks: "1-8", start_week: 1, end_week: 8, week_type: "all" },
    { idx: 3, course_name: "选修", start_time: "19:00", end_time: "20:40", location: "教二楼", weeks: "" },
  ]);
  const p = state.inserts[0];
  eq(p[0].start_week, 1, "英语起始周（文本解析）");
  eq(p[0].end_week, 16, "英语结束周（文本解析）");
  eq(p[0].week_type, "odd", "英语单周（文本解析）");
  eq(p[1].start_week, 1, "体育起始周（结构化）"); eq(p[1].end_week, 8, "体育结束周"); eq(p[1].week_type, "all", "体育每周");
  eq(p[2].start_week, null, "无周信息→NULL"); eq(p[2].end_week, null, "无周信息→NULL"); eq(p[2].week_type, "all", "默认每周");
});

console.log("\n=========================================");
console.log("结果：" + passed + " 通过 / " + failed + " 失败");
console.log("=========================================\n");
process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
