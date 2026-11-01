/* 免登录本地后端 + 配额 冒烟测试（无浏览器，vm 模拟 window/localStorage） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } }

// 迷你 localStorage
function makeLS() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
function load(file, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, { filename: file });
}

const sb = {
  console,
  localStorage: makeLS(),
  location: { replace: (u) => { sb.__redirect = u; } },
  confirm: () => true,
  window: null,
};
sb.window = sb;
load("assets/js/config.js", sb);
load("assets/js/local-backend.js", sb);
load("assets/js/quota.js", sb);

(async () => {
  console.log("=== 本地后端 AppData ===");
  await sb.AppData.saveSettings({ school: "北京大学", semester_start: "2026-09-07", commute_mode: "步行" });
  const s = await sb.AppData.loadSettings();
  ok(s && s.school === "北京大学", "saveSettings/loadSettings 往返");
  ok(s.semester_start === "2026-09-07", "semester_start 保留合法日期");
  await sb.AppData.saveSettings({ commute_mode: "骑行" });
  const s2 = await sb.AppData.loadSettings();
  ok(s2.commute_mode === "骑行" && s2.school === "北京大学", "局部更新不覆盖其它字段");

  await sb.AppData.saveSchedule([{ course_name: "高数", start_time: "08:00" }, { course_name: "线代" }]);
  const sch = await sb.AppData.loadSchedule();
  ok(Array.isArray(sch) && sch.length === 2, "saveSchedule/loadSchedule 往返");

  console.log("=== 本地后端 AppAuth（免登录）===");
  let landed = null;
  await sb.AppAuth.requireAuth((sess) => { landed = sess; });
  ok(landed && landed.user && landed.user.isGuest, "requireAuth 直接放行，视为访客");
  ok(sb.AppAuth.needSetup() === false, "needSetup：已存设置+课表→false");
  await sb.AppAuth.resolveLanding();
  ok(sb.__redirect === "index.html", "resolveLanding：有数据→index.html");

  // 清空数据后应为“需要配置”
  sb.localStorage.removeItem("cb_settings");
  sb.localStorage.removeItem("cb_schedule");
  ok(sb.AppAuth.needSetup() === true, "needSetup：无数据→true（入口应跳 setup.html）");

  console.log("=== 每日配额 Quota ===");
  var LIM = sb.Quota.DAILY_LIMIT;
  ok(sb.Quota.remaining() === LIM, "初始剩余 = 上限 " + LIM);
  for (let i = 0; i < LIM; i++) sb.Quota.guard();
  ok(sb.Quota.remaining() === 0, "调用 " + LIM + " 次后剩余 0");
  let blocked = false;
  try { sb.Quota.guard(); } catch (e) { blocked = !!(e && e.quotaExceeded); }
  ok(blocked, "超限后 guard 抛 quotaExceeded 错误");

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
