/* ===================================================================
   本地免登录后端（替代 Supabase / 未来的 CloudBase）
   ---------------------------------------------------------------------
   用浏览器 localStorage 实现与之前完全一致的 window.AppAuth /
   window.AppData 接口，因此 chat.js / setup.js / schedule-core.js /
   apis.js 等所有业务代码无需改动。

   设计要点：
   - 免登录：视为常驻“访客”会话，requireAuth 直接放行，不跳转 auth.html。
   - 数据全部存在本机浏览器，不上云（后续接 CloudBase 时只换本文件）。
   - 字段对齐 schema.sql / supabase.js：UserSettings 单对象、ScheduleData 数组。
   - signOut 在这里等价于“清空本机数据并重新配置”（无登录概念）。
   =================================================================== */
(function () {
  "use strict";

  var SETTINGS_KEY = "cb_settings";   // 用户设置（单个对象）
  var SCHEDULE_KEY = "cb_schedule";   // 课表（数组，每门课一行）
  var GUEST_UID = "local-guest";

  // 需要持久化的设置字段（与 schema.sql / supabase.js 对齐）
  var SETTINGS_COLS = [
    "school", "semester_start", "default_departure", "commute_mode",
    "weather_on", "time_scheme"
  ];

  function readJSON(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      console.error("[local] 读取失败", key, e);
      return fallback;
    }
  }
  function writeJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.error("[local] 写入 localStorage 失败（可能已满）", key, e);
    }
  }

  /* ---------------- AppAuth：免登录，常驻访客会话 ---------------- */
  function session() {
    return { user: { uid: GUEST_UID, id: GUEST_UID, isGuest: true } };
  }
  function getSession() { return Promise.resolve(session()); }
  function getCurrentUser() { return Promise.resolve(session().user); }

  function requireAuth(cb) {
    // 免登录：直接放行，绝不跳转 auth.html
    return getSession().then(function (s) { return cb(s); });
  }

  // 首次使用判定：本机还没有默认设置 → 需要走 setup.html 填写
  // （课表改由对话页内上传，不再作为进入门槛）
  function needSetup() {
    var settings = readJSON(SETTINGS_KEY, null);
    return !settings;
  }

  // 落地分发（保持兼容；入口路由改用 needSetup 避免自跳循环）
  function resolveLanding() {
    location.replace(needSetup() ? "setup.html" : "index.html");
  }

  function resetLocalData() {
    // 无登录概念：清空本机数据并回到配置页（不动每日额度 cb_quota）
    try {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(SCHEDULE_KEY);
    } catch (e) {}
    location.replace("setup.html");
  }

  function signOut() {
    // 兼容旧调用：原生确认后再清空（前端自定义弹窗直接调 resetLocalData）
    if (!window.confirm("确定清空本机所有通勤数据并重新配置吗？此操作不可恢复。")) return;
    resetLocalData();
  }

  /* ---------------- AppData：localStorage CRUD ---------------- */
  function loadSettings() {
    return Promise.resolve(readJSON(SETTINGS_KEY, null));
  }

  function pickSettings(values) {
    var out = {};
    SETTINGS_COLS.forEach(function (k) {
      if (!values || values[k] === undefined) return;
      if (k === "semester_start") {
        // DATE 列不接受空串：未填 / 格式不对一律写 null
        var v = String(values[k]).trim();
        out[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
        return;
      }
      out[k] = values[k];
    });
    return out;
  }

  function saveSettings(values) {
    var cur = readJSON(SETTINGS_KEY, {});
    var merged = Object.assign({}, cur, pickSettings(values));
    writeJSON(SETTINGS_KEY, merged);
    return Promise.resolve();
  }

  function loadSchedule() {
    var v = readJSON(SCHEDULE_KEY, []);
    return Promise.resolve(Array.isArray(v) ? v : []);
  }

  function saveSchedule(rows) {
    writeJSON(SCHEDULE_KEY, Array.isArray(rows) ? rows : []);
    return Promise.resolve();
  }

  window.AppAuth = {
    getSession: getSession,
    getCurrentUser: getCurrentUser,
    requireAuth: requireAuth,
    needSetup: needSetup,
    resolveLanding: resolveLanding,
    signOut: signOut,
    resetLocalData: resetLocalData
  };
  function exportAll() {
    return {
      app: "campus-commute",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: readJSON(SETTINGS_KEY, null),
      schedule: readJSON(SCHEDULE_KEY, [])
    };
  }
  function importAll(data) {
    return new Promise(function (resolve, reject) {
      try {
        if (!data || typeof data !== "object") throw new Error("无效的备份文件");
        if (data.settings && typeof data.settings === "object") writeJSON(SETTINGS_KEY, data.settings);
        if (Array.isArray(data.schedule)) writeJSON(SCHEDULE_KEY, data.schedule);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  window.AppData = {
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    loadSchedule: loadSchedule,
    saveSchedule: saveSchedule,
    exportAll: exportAll,
    importAll: importAll
  };
})();
