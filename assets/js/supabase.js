/* ===================================================================
   Supabase 接入层
   - 用 supabase-js（CDN 全局变量 window.supabase）初始化客户端
   - 身份认证：邮箱 + 密码（注册 / 登录 / 登出 / 找回密码在 auth.html）
   - 数据访问：user_settings、schedule_data 两张表
   - 对业务层暴露稳定的 window.AppAuth / window.AppData 接口。

   安全：所有数据通过 RLS（user_id = auth.uid()）在数据库层隔离，
        前端绝不手动写 user_id，会话由 supabase-js 自动附带。

   模块一（登录后路由分发）：resolveLanding()
     登录成功 → 查 user_settings 与 schedule_data：
       · 两表都有当前用户数据 → index.html（智能体对话页）
       · 任一为空（新用户 / 引导未完成）→ setup.html（首次配置引导页）

   模块三（局部更新）保障：
     saveSettings 只写 user_settings，saveSchedule 只写 schedule_data，
     两者互不触碰，由调用方按需选择。
   =================================================================== */
(function () {
  "use strict";

  var cfg = window.SUPABASE_CONFIG;
  if (!cfg || !window.supabase) {
    console.error("[supabase] 缺少 SUPABASE_CONFIG 或 supabase-js 未加载（检查 CDN <script> 是否在 config.js / supabase.js 之前）");
    return;
  }

  var client = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  window.sb = client; // 供 auth.js 直接使用

  // ---------------- 会话 ----------------
  async function getSession() {
    try {
      var r = await client.auth.getSession();
      if (r.error) { console.error(r.error); return null; }
      return r.data && r.data.session ? r.data.session : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async function getCurrentUser() {
    var s = await getSession();
    return s ? s.user : null;
  }

  function redirectToAuth(next) {
    var dest = "auth.html";
    if (!next) next = location.pathname + location.search;
    dest += "?next=" + encodeURIComponent(next);
    location.replace(dest);
  }

  // ---------------- 模块一：登录后路由分发 ----------------
  // 规则：user_settings 与 schedule_data 两表都有当前用户数据 → 对话页；
  //       否则 → 首次配置引导页（新用户从上传开始，半完成用户由 setup.js 续做）。
  async function resolveLanding() {
    var s = await getSession();
    if (!s) { redirectToAuth(); return false; }
    var settings = null, schedule = [];
    try { settings = await loadSettings(); } catch (e) { console.error(e); }
    try { schedule = await loadSchedule(); } catch (e) { console.error(e); }
    var configured = !!settings && !!(schedule && schedule.length);
    location.replace(configured ? "index.html" : "setup.html");
    return configured;
  }

  window.AppAuth = {
    client: client,
    getSession: getSession,
    getCurrentUser: getCurrentUser,
    resolveLanding: resolveLanding,
    async requireAuth(cb) {
      var s = await getSession();
      if (!s) { redirectToAuth(); return null; }
      try { await cb(s); } catch (e) { console.error(e); }
      return s;
    },
    async signOut() {
      try { await client.auth.signOut(); } catch (e) { console.error(e); }
      location.replace("auth.html");
    }
  };

  // 首页「退出」按钮
  var logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", function () {
      window.AppAuth.signOut();
    });
  }

  // ---------------- 数据访问层 ----------------
  async function loadSettings() {
    var r = await client
      .from("user_settings")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);
    if (r.error) throw r.error;
    return r.data && r.data[0] ? r.data[0] : null;
  }

  // 支持的设置列（与 db/schema.sql 对齐；semester_start 为第六步新增：
  // 学期第一周的周一日期，用于计算当前周数、判断单双周与起止周次）
  var SETTINGS_COLS = [
    "school", "semester_start", "default_departure", "commute_mode",
    "weather_on", "notify_on"
  ];

  function pickSettings(values) {
    var out = {};
    SETTINGS_COLS.forEach(function (k) {
      if (!values || values[k] === undefined) return;
      if (k === "semester_start") {
        // DATE 列不接受空串：未填 / 格式不对一律写 NULL（表示未设置学期起点）
        var v = String(values[k]).trim();
        out[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
        return;
      }
      out[k] = values[k];
    });
    return out;
  }

  // 只写 user_settings，绝不触碰 schedule_data。
  // 有 user_id 唯一索引时优先 upsert；旧库没有唯一约束则退化为 查→改/插。
  async function saveSettings(values) {
    var s = await getSession();
    if (!s) throw new Error("未登录");
    var payload = pickSettings(values);

    try {
      var up = await client.from("user_settings").upsert(payload, { onConflict: "user_id" });
      if (!up.error) return;
      console.warn("[settings] upsert 失败，退化为 update/insert：", up.error.message);
    } catch (e) {
      console.warn("[settings] upsert 异常，退化为 update/insert", e);
    }

    var existing = await loadSettings();
    if (existing) {
      var u = await client.from("user_settings").update(payload).eq("id", existing.id);
      if (u.error) throw u.error;
    } else {
      var i = await client.from("user_settings").insert(payload);
      if (i.error) throw i.error;
    }
  }

  async function loadSchedule() {
    var r = await client
      .from("schedule_data")
      .select("*")
      .order("id", { ascending: true });
    if (r.error) throw r.error;
    return r.data || [];
  }

  // 覆盖保存课表：先删除当前用户全部课表行，再批量插入（RLS 只放行本人行）。
  // 只写 schedule_data，绝不触碰 user_settings。
  // 第六步：同时写入结构化周次字段 start_week / end_week / week_type
  // （行上已带则用行上的；缺失时从 weeks 文本解析）。
  async function saveSchedule(rows) {
    var s = await getSession();
    if (!s) throw new Error("未登录");
    var del = await client.from("schedule_data").delete().neq("id", 0);
    if (del.error) throw del.error;
    var parse = (window.ScheduleCore && window.ScheduleCore.parseWeeks)
      ? window.ScheduleCore.parseWeeks
      : function () { return { start: null, end: null, type: "all", hasParity: false }; };
    var normType = (window.ScheduleCore && window.ScheduleCore.normWeekType)
      ? window.ScheduleCore.normWeekType
      : function (v) { return v || null; };
    var payload = (rows || []).map(function (rw) {
      var wk = parse(rw.weeks);
      var sw = rw.start_week != null && rw.start_week !== "" ? parseInt(rw.start_week, 10) : wk.start;
      var ew = rw.end_week != null && rw.end_week !== "" ? parseInt(rw.end_week, 10) : wk.end;
      var wt = normType(rw.week_type) || (wk.hasParity ? wk.type : "all") || "all";
      return {
        course_name: rw.course_name || rw.name || "",
        start_time: rw.start_time || rw.start || "",
        end_time: rw.end_time || rw.end || "",
        location: rw.location || rw.room || "",
        weeks: rw.weeks || "",
        start_week: sw == null || !isFinite(sw) ? null : sw,
        end_week: ew == null || !isFinite(ew) ? null : ew,
        week_type: wt
      };
    });
    if (payload.length) {
      var ins = await client.from("schedule_data").insert(payload);
      if (ins.error) throw ins.error;
    }
  }

  window.AppData = {
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    loadSchedule: loadSchedule,
    saveSchedule: saveSchedule
  };
})();
