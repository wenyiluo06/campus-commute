/* ===================================================================
   首次配置引导页（课表上传 + 默认设置，同页）
   ---------------------------------------------------------------------
   - 模块一：上传课表图片 → 真实 AI 识别（智谱 glm-4v-flash）→ 摘要预览
   - 模块二：默认信息设置（学校 / 学期起点 / 出发地 / 通勤方式 /
            天气开关）
   - 「保存并进入」：写设置 + 课表，并置 campus_show_verify 标记；
     进入对话页后由 chat.js 以对话气泡形式展示核对卡（首次核对）。

   实现约束：
   - 不新增 / 不修改既有 CSS 类，仅用 JS 控制交互。
   - 数据通过 window.AppData 写入 localStorage（免登录后端）。
   =================================================================== */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  // 待保存的课表（识别结果），保存时一并写入
  var pendingSchedule = null;

  // ---- 轻提示 ----
  function toast(text) {
    var old = $("setupToast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "tip";
    el.id = "setupToast";
    el.textContent = text;
    var main = document.querySelector(".setup-page");
    if (main) main.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 3200);
  }

  // ---- ② 默认信息设置：日期默认值 / 回填 / 读取 ----
  function normDateStr(s) {
    var m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }

  function prefillSemester() {
    var el = $("semester");
    if (!el || el.value) return;
    var d = new Date();
    var offset = (d.getDay() + 6) % 7; // 周一=0
    d.setDate(d.getDate() - offset);
    el.value = d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function prefillSettingsForm(s) {
    if (!s) return;
    var map = { school: "school", semester_start: "semester", default_departure: "depart",
      commute_mode: "mode" };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (el && s[k] != null) el.value = s[k];
    });
    if (s.weather_on != null) { var w = $("weather"); if (w) w.checked = !!s.weather_on; }
    // 令时：默认冬令时，按存储值回填
    var scheme = (s.time_scheme === "summer") ? "summer" : "winter";
    var schemeEl = document.querySelector('input[name="timeScheme"][value="' + scheme + '"]');
    if (schemeEl) schemeEl.checked = true;
  }

  function readSettingsForm() {
    var depart = $("depart"), mode = $("mode"),
        weather = $("weather"),
        school = $("school"), semester = $("semester");
    var schemeEl = document.querySelector('input[name="timeScheme"]:checked');
    return {
      school: school ? school.value.trim() : "",
      semester_start: semester ? normDateStr(semester.value) : "",
      default_departure: depart ? depart.value.trim() : "",
      commute_mode: mode ? mode.value : "",
      weather_on: weather ? weather.checked : true,
      time_scheme: schemeEl ? schemeEl.value : "winter"
    };
  }

  // ---- ① 课表上传 + 真实识别 ----
  function setRecognizeTip(text, show) {
    var tip = $("recognizeTip");
    if (!tip) return;
    tip.textContent = text;
    tip.style.display = (show === false) ? "none" : "block";
    if (!text) tip.style.display = "none";
  }

  function bindUpload() {
    var zone = $("uploadZone");
    var file = $("scheduleFile");
    var nameEl = $("uploadFileName");
    if (!zone || !file) return;

    zone.addEventListener("click", function () { file.click(); });
    zone.addEventListener("dragover", function (e) { e.preventDefault(); });
    zone.addEventListener("drop", function (e) {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (f) handleFile(f);
    });

    function handleFile(f) {
      if (nameEl) nameEl.textContent = "已选择：" + f.name;
      pendingSchedule = null;
      if (!window.LLM || !window.LLM.isReady()) {
        setRecognizeTip("⚠️ 未配置智谱大模型 Key，不能识别图片。请先在 config.js 填入 Key，或在对话页「设置修改」里上传课表。", true);
        return;
      }
      setRecognizeTip("正在识别课表…", true);
      window.LLM.recognizeSchedule(f).then(function (rows) {
        if (!rows || !rows.length) {
          setRecognizeTip("没从图片里认出课程，换个清晰、正向的课表图片再试～", true);
          return;
        }
        pendingSchedule = rows;
        setRecognizeTip("✅ 已识别 " + rows.length + " 门课程，进入对话页后可逐行核对修改。", true);
      }).catch(function (e) {
        console.error("[识别] 失败详情（含原始错误）：", e);
        var msg;
        if (e && e.quotaExceeded) msg = "⚠️ 今日免费额度已用完";
        else msg = window.diagnoseProxyError ? window.diagnoseProxyError(e && e.message) : ("识别失败：" + ((e && e.message) || "请重试"));
        setRecognizeTip(msg, true);
      });
    }
  }

  // ---- 从备份文件导入课表（与设置页“导入/导出备份”相呼应） ----
  function bindImportSchedule() {
    var btn = $("importScheduleBtn");
    var file = $("importScheduleFile");
    if (!btn || !file) return;
    btn.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", async function () {
      var f = file.files && file.files[0];
      if (!f) return;
      try {
        var text = await f.text();
        var data = JSON.parse(text);
        if (!window.confirm("导入备份将覆盖当前的课表与设置，确定继续吗？（建议先记下已填内容）")) {
          file.value = "";
          return;
        }
        if (window.AppData && window.AppData.importAll) {
          await window.AppData.importAll(data);
        }
        // 重新读取设置回填表单，并提示已导入课表行数
        var s = null;
        if (window.AppData && window.AppData.loadSettings) {
          try { s = await window.AppData.loadSettings(); } catch (e) {}
        }
        if (s) prefillSettingsForm(s);
        var rows = [];
        if (window.AppData && window.AppData.loadSchedule) {
          try { rows = await window.AppData.loadSchedule(); } catch (e) {}
        }
        toast("✅ 已导入备份：课表 " + rows.length + " 门、设置已恢复。确认无误后点「保存并进入」即可。");
        file.value = "";
      } catch (e) {
        console.error(e);
        toast("导入失败：文件不是有效的备份 JSON（" + ((e && e.message) || "格式错误") + "）");
        file.value = "";
      }
    });
  }

  // ---- 底部「保存并进入」：写默认设置 + 课表，置核对标记 ----
  function initSave() {
    var btn = $("saveSetupBtn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      var school = $("school"), semester = $("semester"), depart = $("depart");
      if (school && !school.value.trim()) {
        toast("请先填写学校名称（有校区请一起写上，便于定位教学楼）"); school.focus(); return;
      }
      if (semester && !normDateStr(semester.value)) {
        toast("请选择学期第一周的周一日期（用它判断现在是第几周、单双周）"); semester.focus(); return;
      }
      if (depart && !depart.value.trim()) {
        toast("请先填写默认出发地（宿舍 / 家）"); depart.focus(); return;
      }

      btn.disabled = true;
      btn.textContent = "保存中…";
      try {
        if (window.AppData && window.AppData.saveSettings) {
          await window.AppData.saveSettings(readSettingsForm());
        }
        if (pendingSchedule && window.AppData && window.AppData.saveSchedule) {
          await window.AppData.saveSchedule(pendingSchedule);
          // 标记：进入对话页后以对话气泡形式展示核对卡（首次核对）
          try { localStorage.setItem("campus_show_verify", "1"); } catch (_) {}
        }
        window.location.href = "index.html"; // 全部完成 → 智能体对话页
      } catch (e) {
        console.error(e);
        toast("保存失败：" + ((e && e.message) || "请稍后再试"));
        btn.disabled = false;
        btn.textContent = "保存并进入 →";
      }
    });
  }

  // ---- 入口：免登录放行 + 渲染 ----
  document.addEventListener("DOMContentLoaded", async function () {
    if (!window.AppAuth || !window.AppAuth.requireAuth) { initSave(); bindUpload(); bindImportSchedule(); prefillSemester(); return; }

    window.AppAuth.requireAuth(async function () {
      var settings = null;
      if (window.AppData) {
        try { settings = await window.AppData.loadSettings(); } catch (e) { console.error(e); }
      }
      bindUpload();
      bindImportSchedule();
      initSave();
      prefillSemester();
      if (settings) prefillSettingsForm(settings);
    });
  });
})();
