/* ===================================================================
   课表核心（共享）：内存 State + 归一化 + 自然语言修改（Mock）+ 核对卡片渲染
   - 首页（chat.js）与首次配置页（setup.js）共用同一份课表真值；
   - 表格单元格（含课名 / 教室）可直接点选修改；自然语言修改统一走对话输入框
     （chat.js 的 applyScheduleEdit）。是否立即落库由卡片上的
     data-persist 标记决定：
       · 对话页核对卡（老用户改课表）   persist=1 → 每次改动即时写云端
       · 首次配置 / 设置页新课表核对卡   persist=0 → 只改内存，点确认后才写云端
   - 第六步（单双周 / 起止周次）：每行带 weeks 文本 + 结构化字段
     start_week / end_week / week_type（all=每周 / odd=单周 / even=双周）；
     核对表新增「周次」「单双周」两列，文本与下拉改动会互相同步。
   - 渲染复用既有 .verify-card / .verify-table / .vc-input / .hint 样式，
     不新增任何 CSS；仅在 JS 生成的节点上用少量行内样式控制布局。
   =================================================================== */
window.ScheduleCore = (function () {
  "use strict";

  // state.rows 是“稳定数组”：setRows 只就地替换内容、不换引用，
  // 这样已渲染出来的核对卡片始终指向最新数据（保存后自动刷新）。
  var state = {
    rows: [],               // 当前课表（云端 schedule_data 的本地镜像）
    source: null,           // 'cloud' | 'mock' | 'local'
    pending: null,          // 设置页：待确认的新课表（尚未落库）
    pendingConfirmed: false // 设置页：新课表是否已核对确认
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function nowHM() {
    return new Date().toTimeString().slice(0, 5);
  }

  // 时间归一化：把各种常见写法统一成标准 HH:MM（供原生 time 选择器显示/存储）
  //   "08:00" / "8:00" → "08:00"
  //   "0830" / "830"  → "08:30"
  //   无法识别则原样返回（保持兼容，不会丢数据）
  function pad2(n) { return String(n).padStart(2, "0"); }
  function normTime(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return "";
    var m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) return pad2(m[1]) + ":" + pad2(m[2]);
    var m2 = s.match(/^(\d{1,2})(\d{2})$/);
    if (m2) return pad2(m2[1]) + ":" + pad2(m2[2]);
    return s;
  }

  /* ---------------- 周次工具（第六步：单双周 / 起止周次） ----------------
     weeks 文本（识别原始结果）："1-16" / "单周" / "双周" / "1-8,10-16" / "3" / "第1-16周"
     结构化字段（入库列）：start_week 起始周次 / end_week 结束周次 /
                          week_type 单双周（all=每周 / odd=单周 / even=双周） */
  function toInt(v) {
    if (v == null || v === "") return null;
    var n = parseInt(v, 10);
    return isFinite(n) ? n : null;
  }
  function normWeekType(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return null;
    if (s === "odd" || s.indexOf("单") > -1) return "odd";
    if (s === "even" || s.indexOf("双") > -1) return "even";
    if (s === "all" || s.indexOf("每") > -1 || s.indexOf("全") > -1) return "all";
    return null;
  }
  function parseWeeks(s) {
    var out = { start: null, end: null, type: "all", hasRange: false, hasParity: false };
    var str = String(s == null ? "" : s).trim();
    if (!str) return out;
    if (str.indexOf("单") > -1) { out.type = "odd"; out.hasParity = true; }
    else if (str.indexOf("双") > -1) { out.type = "even"; out.hasParity = true; }
    var nums = [];
    var re = /(\d+)\s*[-~至到]\s*(\d+)|(\d+)/g;
    var m;
    while ((m = re.exec(str))) {
      if (m[1]) { for (var i = +m[1]; i <= +m[2]; i++) nums.push(i); }
      else nums.push(+m[3]);
    }
    if (nums.length) {
      out.hasRange = true;
      out.start = Math.min.apply(null, nums);
      out.end = Math.max.apply(null, nums);
    }
    return out;
  }
  // 行的周次展示文案（如「第 2-15 周 · 单周」）；结构化字段优先，缺失时读 weeks 文本
  function formatWeeks(row) {
    var wk = parseWeeks(row && row.weeks);
    var s = toInt(row && row.start_week), e = toInt(row && row.end_week);
    if (s == null) s = wk.start;
    if (e == null) e = wk.end;
    var t = normWeekType(row && row.week_type) || wk.type;
    var parts = [];
    if (s != null && e != null) parts.push(s === e ? "第 " + s + " 周" : "第 " + s + "-" + e + " 周");
    else if (s != null) parts.push("第 " + s + " 周起");
    else if (e != null) parts.push("至第 " + e + " 周");
    if (t === "odd") parts.push("单周");
    else if (t === "even") parts.push("双周");
    return parts.length ? parts.join(" · ") : "每周";
  }
  // 文本周次改动后，把结构化字段同步成文本的解析结果
  function syncWeekStruct(row) {
    var p = parseWeeks(row.weeks);
    row.start_week = p.start;
    row.end_week = p.end;
    if (p.hasParity) row.week_type = p.type;
    return row;
  }

  // 任意来源（云端 schedule_data / Mock 识别 / 示例）→ 统一结构
  // day/weekday 为可选字段（周一=1…周日=7，或「周三」）：课表未标注星期时留空，
  // 表示该课表适用于每天；第五步自动推送按它筛选「当天」课程（见 auto-push.js）。
  // weeks 为周数文本；start_week/end_week/week_type 为结构化周次字段
  // （第六步新增，云端列）；缺失时由 parseWeeks(weeks) 反推。
  function normalize(rows) {
    return (rows || []).map(function (r, i) {
      var wk = parseWeeks(r.weeks);
      var sw = toInt(r.start_week), ew = toInt(r.end_week);
      var wt = normWeekType(r.week_type);
      if (sw == null && ew == null && wk.hasRange) { sw = wk.start; ew = wk.end; }
      if (!wt) wt = wk.hasParity ? wk.type : "all";
      return {
        idx: r.idx != null ? r.idx : i + 1,
        course_name: r.course_name || r.name || "",
        start_time: r.start_time || r.start || "",
        end_time: r.end_time || r.end || "",
        location: r.location || r.room || "",
        weeks: r.weeks || "",
        day: r.day != null ? r.day : (r.weekday != null ? r.weekday : ""),
        start_week: sw,
        end_week: ew,
        week_type: wt
      };
    });
  }

  function setRows(rows, source) {
    var next = normalize(rows);
    state.rows.length = 0;
    next.forEach(function (r) { state.rows.push(r); });
    state.source = source || "local";
    return state.rows;
  }

  function getRows() { return state.rows; }

  function findRow(rows, idx) {
    for (var i = 0; i < rows.length; i++) if (rows[i].idx === idx) return rows[i];
    return null;
  }

  function patchRow(rows, idx, patch) {
    var row = findRow(rows, idx);
    if (!row) return null;
    Object.keys(patch).forEach(function (k) { row[k] = patch[k]; });
    return row;
  }

  // 自然语言修改（Mock 解析）：
  // 「第 N 节 开始/结束 改成 HH:MM」「第 N 节 HH:MM-HH:MM」「第 N 节 教室改成 xxx」
  // rows 默认操作当前 State；传入其他数组（如设置页 pending）则改那份。
  function parseEdit(text, rows) {
    rows = rows || state.rows;
    var num = String(text || "").match(/第\s*(\d+)\s*节/);
    if (!num) return null;
    var idx = +num[1];
    var row = findRow(rows, idx);
    if (!row) return { ok: false, ack: "没有找到第 " + idx + " 节课，请确认节次是否正确～" };

    var range = text.match(/(\d{1,2}:\d{2})\s*[-~至到]\s*(\d{1,2}:\d{2})/);
    var startM = text.match(/(开始|上课)\D{0,6}(\d{1,2}:\d{2})/);
    var endM = text.match(/(结束|下课|放学)\D{0,6}(\d{1,2}:\d{2})/);
    var roomM = text.match(/教室\D{0,6}([\u4e00-\u9fa5A-Za-z0-9（）() ]+)/);
    // 周次相关（第六步）：「周次改成 1-8」「改成单周 / 双周 / 每周」
    var weekNumM = text.match(/周次\D{0,6}(\d{1,2}\s*[-~至到]\s*\d{1,2}|\d{1,2})/);
    var parityM = text.match(/(单周|双周|每周|全学期|整学期)/);

    var changed = false;
    if (range) { row.start_time = range[1]; row.end_time = range[2]; changed = true; }
    else {
      if (startM) { row.start_time = startM[2]; changed = true; }
      if (endM) { row.end_time = endM[2]; changed = true; }
    }
    if (roomM) { row.location = roomM[1].trim(); changed = true; }
    if (weekNumM) {
      row.weeks = weekNumM[1];
      syncWeekStruct(row); // 同步 start_week / end_week（文本含单/双则连 week_type 一起同步）
      changed = true;
    }
    if (parityM) {
      row.week_type = normWeekType(parityM[1]) || "all";
      row.weeks = String(row.weeks || "").replace(/[单双]周?/g, "").trim(); // 去掉文本里的单/双字样，避免与下拉冲突
      changed = true;
    }

    if (!changed) {
      return { ok: false, ack: "第 " + idx + " 节课我没法判断你要改哪一项，试试说「第 " + idx + " 节结束时间改成 15:40」或「第 " + idx + " 节周次改成 1-8」。" };
    }
    var parts = [];
    if (range || startM) parts.push("开始 " + row.start_time);
    if (range || endM) parts.push("结束 " + row.end_time);
    if (roomM) parts.push("教室 " + row.location);
    if (weekNumM) parts.push("周次 " + row.weeks);
    if (parityM) parts.push(row.week_type === "odd" ? "单周" : row.week_type === "even" ? "双周" : "每周");
    return { ok: true, ack: "已更新第 " + idx + " 节（" + row.course_name + "）：" + parts.join("，") + "。" };
  }

  // 用数据回填核对卡里的输入框（自然语言修改后调用）
  function syncInputs(root, rows) {
    rows = rows || state.rows;
    (root || document).querySelectorAll(".vc-input[data-idx]").forEach(function (inp) {
      var idx = +inp.dataset.idx;
      var key = inp.dataset.field === "start" ? "start_time"
             : inp.dataset.field === "end" ? "end_time"
             : inp.dataset.field;
      var row = findRow(rows, idx);
      if (row) {
        var v = (key === "start_time" || key === "end_time") ? normTime(row[key]) : (row[key] || "");
        if (inp.value !== v) inp.value = v;
      }
    });
  }

  /* ---------------- 核对表行构造 / 增删改辅助 ----------------
     课名(course_name) / 教室(location) 均作为可编辑 input（与其他字段一致），
     改动经全局 change 监听写入该卡片绑定的数据集合；persist 卡片即时落库。
     每行末尾「删除」按钮、表下方「＋ 添加课程」按钮通过卡片事件委托处理，
     增删后重渲染 tbody 并重新编号 idx（节次）。自然语言修改统一走对话输入框。 */
  function blankRow(idx) {
    return { idx: idx, course_name: "", start_time: "", end_time: "", location: "", weeks: "", day: "", start_week: null, end_week: null, week_type: "all" };
  }
  function renumber(rows) { rows.forEach(function (r, i) { r.idx = i + 1; }); }
  function buildTrs(rows) {
    var WEEK_TYPE_OPTS = [["all", "每周"], ["odd", "单周"], ["even", "双周"]];
    var DAY_OPTS = [["", "每天"], ["1", "周一"], ["2", "周二"], ["3", "周三"], ["4", "周四"], ["5", "周五"], ["6", "周六"], ["7", "周日"]];
    return rows.map(function (r) {
      var wt = normWeekType(r.week_type) || parseWeeks(r.weeks).type;
      var wLabel = String(r.weeks || "").trim();
      if (!wLabel && (toInt(r.start_week) != null || toInt(r.end_week) != null)) {
        wLabel = (toInt(r.start_week) != null ? r.start_week : 1) + "-" + (toInt(r.end_week) != null ? r.end_week : 20);
      }
      var wtOpts = WEEK_TYPE_OPTS.map(function (o) {
        return '<option value="' + o[0] + '"' + (wt === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("");
      var dayVal = (r.day != null && r.day !== "" && r.day !== 0) ? String(r.day) : "";
      var dayOpts = DAY_OPTS.map(function (o) {
        return '<option value="' + o[0] + '"' + (dayVal === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("");
      return '<tr data-idx="' + r.idx + '">' +
        '<td class="vc-idx">' + r.idx + "</td>" +
        '<td><select class="vc-input" data-idx="' + r.idx + '" data-field="day" style="width:62px">' + dayOpts + "</select></td>" +
        '<td><input class="vc-input" data-idx="' + r.idx + '" data-field="course_name" value="' + esc(r.course_name) + '" style="min-width:88px" /></td>' +
        '<td><input type="time" class="vc-input" data-idx="' + r.idx + '" data-field="start" value="' + esc(normTime(r.start_time)) + '" style="width:74px" /></td>' +
        '<td><input type="time" class="vc-input" data-idx="' + r.idx + '" data-field="end" value="' + esc(normTime(r.end_time)) + '" style="width:74px" /></td>' +
        '<td><input class="vc-input" data-idx="' + r.idx + '" data-field="location" value="' + esc(r.location) + '" style="min-width:76px" /></td>' +
        '<td><input class="vc-input" data-idx="' + r.idx + '" data-field="weeks" value="' + esc(wLabel) + '" placeholder="1-16" style="width:58px" /></td>' +
        '<td><select class="vc-input" data-idx="' + r.idx + '" data-field="week_type" style="width:64px">' + wtOpts + "</select></td>" +
        '<td><button type="button" class="btn btn-ghost vc-del-btn" data-idx="' + r.idx + '" style="padding:2px 8px;font-size:12px;white-space:nowrap">删除</button></td>' +
        "</tr>";
    }).join("");
  }
  function commitInputs(root, rows) {
    (root || document).querySelectorAll(".vc-input[data-idx]").forEach(function (inp) {
      var idx = +inp.dataset.idx;
      var key = inp.dataset.field === "start" ? "start_time"
             : inp.dataset.field === "end" ? "end_time"
             : inp.dataset.field;
      var row = findRow(rows, idx);
      if (row) row[key] = inp.value.trim();
    });
  }
  function saveIfPersist(card, rows) {
    if (card.dataset.persist === "1" && window.AppData && window.AppData.saveSchedule) {
      window.AppData.saveSchedule(rows).catch(function (err) { console.error("[schedule] 保存失败", err); });
    }
  }
  // 渲染核对卡片（详见上方辅助函数说明），返回 DOM 节点
  // opts: { rows, persist, headText, descText, confirmText, onConfirm(rows, cardNode) }
  function renderVerifyCard(opts) {
    opts = opts || {};
    var rows = opts.rows || state.rows;
    var persist = !!opts.persist;

    var WEEK_TYPE_OPTS = [["all", "每周"], ["odd", "单周"], ["even", "双周"]];
    var DAY_OPTS = [["", "每天"], ["1", "周一"], ["2", "周二"], ["3", "周三"], ["4", "周四"], ["5", "周五"], ["6", "周六"], ["7", "周日"]];
    var trs = buildTrs(rows);

    var wrap = document.createElement("div");
    wrap.className = "msg agent";
    var card = document.createElement("div");
    card.className = "verify-card";
    if (persist) card.setAttribute("data-persist", "1");
    card.innerHTML =
        '<div class="vc-head">' + esc(opts.headText || "📋 课表核对") + "</div>" +
        '<p class="vc-desc">' + esc(opts.descText || "我已根据你上传的课表解析出以下课程，请核对每节课的星期、起止时间、教室与周次。表格内可直接点选修改，也可用下方对话框以自然语言告诉我（如「第 2 节教室改成教三楼 302」）。确认无误点「确认保存」。") + "</p>" +
        '<div class="vc-table-wrap"><table class="verify-table"><thead><tr>' +
          "<th>节</th><th>星期</th><th>课程</th><th>开始</th><th>结束</th><th>教室</th><th>周次</th><th>单双周</th><th>操作</th>" +
        "</tr></thead><tbody>" + trs + "</tbody></table></div>" +
        '<div class="vc-actions" style="margin-top:10px"><button type="button" class="btn btn-ghost vc-add-btn" style="width:100%;justify-content:center">＋ 添加课程</button></div>' +
        '<button class="btn btn-primary vc-confirm" type="button" style="width:100%;justify-content:center;margin-top:10px">' +
          esc(opts.confirmText || "✅ 确认无误，保存课表") +
        "</button>";

    card._rows = rows; // 卡片绑定的数据集合：改这张表只改这份

    var confirmBtn = card.querySelector(".vc-confirm");
    if (confirmBtn) {
      confirmBtn.addEventListener("click", function () {
        if (opts.onConfirm) opts.onConfirm(rows, wrap);
      });
    }

    wrap.innerHTML = '<div class="avatar">🤖</div><div class="bubble"></div>';
    wrap.querySelector(".bubble").appendChild(card);
    var t = document.createElement("span");
    t.className = "time";
    t.textContent = nowHM();
    wrap.querySelector(".bubble").appendChild(t);
    return wrap;
  }

  // 全局委托：核对表输入框改动 → 改该卡片绑定的数据集合；
  // 若卡片带 data-persist="1"（对话页老用户改课表），即时写云端。
  // 周次文本（weeks）/ 单双周下拉（week_type）改动时，同步另一部分，
  // 保证入库的结构化字段（start_week/end_week/week_type）与文本一致。
  document.addEventListener("change", function (e) {
    var inp = e.target && e.target.closest ? e.target.closest(".vc-input[data-idx]") : null;
    if (!inp) return;
    var card = inp.closest(".verify-card");
    var rows = (card && card._rows) || state.rows;
    var patch = {};   // 本处改动集合（此前漏声明，导致严格模式下抛错、编辑从未写入数据）
    var key = inp.dataset.field === "start" ? "start_time"
           : inp.dataset.field === "end" ? "end_time"
           : inp.dataset.field;
    var val = inp.value.trim();
    patch[key] = (key === "start_time" || key === "end_time") ? normTime(val) : val;
    if (key === "weeks") {
      var p = parseWeeks(patch.weeks);
      patch.start_week = p.start;
      patch.end_week = p.end;
      if (p.hasParity) patch.week_type = p.type;
    } else if (key === "week_type") {
      var row0 = findRow(rows, +inp.dataset.idx);
      patch.week_type = normWeekType(patch.week_type) || "all";
      // 文本里残留的「单周 / 双周」字样去掉，避免与下拉选择冲突
      patch.weeks = String(row0 ? row0.weeks : "").replace(/[单双]周?/g, "").trim();
    }
    patchRow(rows, +inp.dataset.idx, patch);
    if (card && card.dataset.persist === "1" && window.AppData && window.AppData.saveSchedule) {
      window.AppData.saveSchedule(rows).catch(function (err) {
        console.error("[schedule] 保存失败", err);
      });
    }
  });

  // 重渲染核对表 tbody（删除/添加后调用；rows 已被就地重排节次）
  function rebuildTableBody(card, rows) {
    var tbody = card && card.querySelector(".verify-table tbody");
    if (tbody) tbody.innerHTML = buildTrs(rows);
  }

  // 增删按钮（卡片事件委托）：删除某行 / 末尾追加一行；重排节次后重渲染并即时落库
  document.addEventListener("click", function (e) {
    var t = e.target;
    var del = t && t.closest ? t.closest(".vc-del-btn[data-idx]") : null;
    var add = (!del && t && t.closest) ? t.closest(".vc-add-btn") : null;
    var btn = del || add;
    if (!btn) return;
    var card = btn.closest(".verify-card");
    var rows = (card && card._rows) || state.rows;
    if (del) {
      var idx = +del.dataset.idx;
      var pos = -1;
      for (var i = 0; i < rows.length; i++) { if (rows[i].idx === idx) { pos = i; break; } }
      if (pos < 0) return;
      rows.splice(pos, 1);
      renumber(rows);
      rebuildTableBody(card, rows);
      saveIfPersist(card, rows);
    } else if (add) {
      rows.push(blankRow(rows.length + 1));
      renumber(rows);
      rebuildTableBody(card, rows);
      saveIfPersist(card, rows);
    }
  });

  return {
    state: state,
    normalize: normalize,
    setRows: setRows,
    getRows: getRows,
    findRow: findRow,
    patchRow: patchRow,
    parseEdit: parseEdit,
    syncInputs: syncInputs,
    renderVerifyCard: renderVerifyCard,
    parseWeeks: parseWeeks,
    formatWeeks: formatWeeks,
    normWeekType: normWeekType,
    syncWeekStruct: syncWeekStruct
  };
})();
