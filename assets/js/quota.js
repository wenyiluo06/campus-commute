/* ===================================================================
   每日调用配额（成本控制）
   ---------------------------------------------------------------------
   限制每人每天对“外部 API（智谱 LLM + 高德 + 和风天气）”的总调用次数，
   超出后前端提示「今日免费额度已用完」，从源头避免把第三方免费额度刷爆。

   说明：
   - 计数为本机 localStorage，按自然日自动重置（date 字段比对当天）。
   - 默认上限 40 次/天，改 DAILY_LIMIT 即可调整。
   - guard()：调用前检查——超限抛出带 quotaExceeded 标识的错误（文案可直接展示）；
     通过则 +1。各外部调用点（llm.js / apis.js）在开始发请求前调用它。
   =================================================================== */
(function () {
  "use strict";

  var DAILY_LIMIT = 40;          // 每人每天外部 API 总调用上限
  var KEY = "cb_quota";          // localStorage 键

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function state() {
    var today = todayStr();
    var s;
    try {
      s = JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch (e) { s = {}; }
    if (s.date !== today) s = { date: today, count: 0 }; // 跨天自动重置
    return s;
  }

  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
  }

  function remaining() {
    var s = state();
    return Math.max(0, DAILY_LIMIT - (s.count || 0));
  }

  function canCall() { return remaining() > 0; }

  function record() {
    var s = state();
    s.date = todayStr();
    s.count = (s.count || 0) + 1;
    save(s);
  }

  // 调用前检查：超限时抛出带标识的错误（文案直接可展示）
  function guard() {
    if (!canCall()) {
      var err = new Error("今日免费额度已用完，明天再来看我吧～");
      err.quotaExceeded = true;
      throw err;
    }
    record();
  }

  window.Quota = {
    DAILY_LIMIT: DAILY_LIMIT,
    remaining: remaining,
    canCall: canCall,
    record: record,
    guard: guard
  };
})();
