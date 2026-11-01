/* ===================================================================
   API 测试台逻辑：用假数据（或真实 Key）跑通 CommuteAPI 的两个函数
   - 结果同时输出到页面 <pre> 与浏览器控制台
   - 本文件只服务 test-api.html，不参与主应用
   =================================================================== */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function show(outId, obj, isErr) {
    var el = $(outId);
    if (!el) return;
    el.classList.toggle("err", !!isErr);
    el.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  }

  function fmtTime(ms) {
    var d = new Date(ms);
    return d.toTimeString().slice(0, 8);
  }

  // ---- 当前模式展示 ----
  function renderStatus() {
    if (!window.CommuteAPI) return;
    var st = window.CommuteAPI.status();
    $("stAmap").textContent = st.amap;
    $("stQw").textContent = st.qweather;
  }

  // ---- 通勤时间 ----
  async function runCommute(origin, destination) {
    var mode = $("tMode").value;
    var t0 = Date.now();
    try {
      var minutes = await window.CommuteAPI.getCommuteTime(origin, destination, mode);
      var detail = await window.CommuteAPI.getCommuteDetail(origin, destination, mode);
      var result = {
        调用: "getCommuteTime('" + origin + "', '" + destination + "', '" + mode + "')",
        返回分钟数: minutes,
        详情: detail,
        数据来源: detail.source === "mock" ? "Mock 模拟（未填 Key）" : "高德地图真实 API",
        耗时ms: Date.now() - t0,
        时间: fmtTime(Date.now())
      };
      console.log("[API测试] 通勤时间：", result);
      show("outCommute", result);
    } catch (e) {
      console.error("[API测试] 通勤计算失败：", e);
      show("outCommute", "❌ " + (e && e.message ? e.message : e), true);
    }
  }

  // ---- 天气 ----
  async function runWeather() {
    var loc = $("tLoc").value.trim();
    var hours = parseInt($("tHours").value, 10) || 6;
    var t0 = Date.now();
    try {
      var w = await window.CommuteAPI.checkWeather(loc, { hours: hours });
      var result = {
        调用: "checkWeather('" + loc + "', { hours: " + hours + " })",
        是否下雨: w.raining,
        提示语: w.text,
        数据来源: w.source === "mock" ? "Mock 模拟（未填 Key）" : "和风天气真实 API",
        窗口小时数: w.hours,
        耗时ms: Date.now() - t0,
        时间: fmtTime(Date.now())
      };
      console.log("[API测试] 天气：", result);
      show("outWeather", result);
    } catch (e) {
      console.error("[API测试] 天气查询失败：", e);
      show("outWeather", "❌ " + (e && e.message ? e.message : e), true);
    }
  }

  // ---- 合并查询 ----
  async function runSummary() {
    var origin = $("tOrigin").value.trim();
    var destination = $("tDest").value.trim();
    var mode = $("tMode").value;
    var loc = $("tLoc").value.trim();
    try {
      var s = await window.CommuteAPI.getCommuteSummary(origin, destination, mode, loc);
      var result = {
        调用: "getCommuteSummary(...)",
        通勤耗时分钟: s.minutes,
        距离: s.distanceText,
        交通方式: s.modeLabel,
        是否下雨: s.raining,
        天气提示: s.weatherText,
        数据来源: s.source === "mock" ? "Mock 模拟（未填 Key）" : "真实 API"
      };
      console.log("[API测试] 合并查询：", result);
      show("outWeather", result);
    } catch (e) {
      console.error("[API测试] 合并查询失败：", e);
      show("outWeather", "❌ " + (e && e.message ? e.message : e), true);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.CommuteAPI) {
      show("outCommute", "❌ apis.js 未加载成功", true);
      return;
    }
    renderStatus();

    $("btnCommute").addEventListener("click", function () {
      runCommute($("tOrigin").value.trim(), $("tDest").value.trim());
    });
    $("btnCommuteAddr").addEventListener("click", function () {
      runCommute($("tOriginAddr").value.trim(), $("tDestAddr").value.trim());
    });
    $("btnWeather").addEventListener("click", runWeather);
    $("btnSummary").addEventListener("click", runSummary);

    console.log("%c[API测试台] 已就绪，可直接在控制台调用：", "color:#2f7a55;font-weight:bold");
    console.log("  CommuteAPI.getCommuteTime('116.481028,39.989039', '116.434446,39.981810', 'walk')");
    console.log("  CommuteAPI.checkWeather('116.481028,39.989039', { hours: 6 })");
    console.log("  CommuteAPI.status() →", window.CommuteAPI.status());
  });
})();
