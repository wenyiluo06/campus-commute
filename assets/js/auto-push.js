/* ===================================================================
   第五步 · 对话页「自动推送」+「现在出发」交互（纯 JS 逻辑，不新增 UI）
   ---------------------------------------------------------------------
   模块一 · 页面打开时的自动推送与防重复
     - 读取当前时间 / 星期 / 课表（ScheduleCore = 云端 schedule_data 镜像）：
         白天（18:00 前）→ 当天后续课程；
         晚上（18:00 起）→ 当天剩余课程 + 次日第一节课
                          （周日晚 → 下周一；跨周时按「单/双周」与学期起点换算）；
         周末无课（且不是周日晚）→ 不推送任何课程信息。
     - 周次过滤（第六步）：结构化字段 start_week / end_week / week_type 优先，
         缺失时解析 weeks 文本；当前周数由学期起点（user_settings.semester_start，
         经 setSemesterStart 注入）推算——智能体据此判断「本周是否有这门课」。
     - 防重复推送（核心）：localStorage 记录「今天已推送过哪些课」，
       key = 今天/明天 | 节次 | 课程名 | 开始时间：
         · 退出重进时，未开始的课只重渲染通勤卡片（表格状态），不再输出气泡；
         · 某节课开始 / 跨入新的一天 / 课表变动 → key 变化 → 允许重新推送。
     - 页面持续打开时每 45s + 从后台切回时自动复查（课程开始则静默换表）。
   模块二 ·「现在出发」
     - 点击通勤卡片下方【现在出发】按钮，或在对话框输入
       「现在出发 / 出门了 / 出发吧 …」等自然语言（chat.js 调 departForNext）；
     - 智能体自然语言回复：今天的课 → 预计到达时间 + 多余时间；
       明天的课 → 按路上耗时给出建议出发时间（到达上课时间即可）。
   依赖：ScheduleCore（课表真值）、CommuteAPI（第四步封装）、
        chat.js 的 appendAgentText（全局函数）；
   UI 完全复用第一步的 #commuteCardTpl 通勤卡片模板，零 HTML/CSS 改动。
   =================================================================== */
window.AutoPush = (function () {
  "use strict";

  var EVENING_HOUR = 18;               // 晚间阈值：此后追加「次日第一节课」
  var PUSH_KEY = "campus_autopush_v1"; // 防重复推送缓存（localStorage）
  var DEMO_TRAVEL = "12 分钟";         // 实时耗时不可用时的演示兜底值
  var DEMO_WEATHER = "晴 ☀️，气温 24℃，注意防晒补水";

  var cardMap = {};     // 课程 key → 通勤卡片节点（复用/更新，绝不重复渲染）
  var timer = null;
  var travelCache = {};  // "origin|room|mode" → { minutes }
  var weatherCache = {}; // "origin|hours" → 天气文案
  var scheduleConfirmed = false; // 课表确认门控：未确认前不弹出任何课程 / 通勤信息

  // 课表确认门控：只有用户点过核对卡的「确认保存」才允许推送通勤提醒
  function setConfirmed(v) { scheduleConfirmed = !!v; }
  function isConfirmed() { return scheduleConfirmed; }
  // 移除所有已渲染的通勤卡片 + 重置防重复缓存（新课表待确认时清理旧提醒）
  function clearCommuteCards() {
    var box = document.getElementById("messageList");
    if (box) box.querySelectorAll(".msg.agent .commute-card").forEach(function (c) {
      var wrap = c.closest(".msg.agent");
      if (wrap && wrap.remove) wrap.remove();
    });
    cardMap = {};
    var s = loadState();
    s.shown = {};
    saveState(s);
  }

  /* ---------------- 时间工具 ---------------- */
  function hm(s) {
    var m = String(s || "").match(/(\d{1,2}):(\d{2})/);
    return m ? { h: +m[1], m: +m[2] } : null;
  }
  function minOf(t) { return t ? t.h * 60 + t.m : -1; }
  function nowMin(d) { d = d || new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function atTime(date, t) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), t.h, t.m, 0, 0); }
  function addDays(date, n) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n); }
  function dayKey(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function hhmm(d) { return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }

  /* ---------------- 星期 / 周次匹配 ----------------
     课表行可带 day / weekday（周一=1 … 周日=7，0=周日，或「周三 / Wednesday」）；
     未标注 → 视为每天（当前课表数据即如此；将来带入星期信息的课表同样成立）。
     周次匹配（第六步：单双周 / 起止周次）按两个来源判断，结构化字段优先：
       1) 行上的结构化字段 start_week / end_week / week_type（云端 schedule_data 列，
          用户可在核对表里直接改）；
       2) 都没有时退回解析 weeks 文本（"1-16" / "单周" / "1-8,10-16"）。
     当前第几周由学期起点推算：运行时由 chat.js 从 user_settings.semester_start
     注入（setSemesterStart）；演示模式未注入时退回
     localStorage["campus_semester_start"]（YYYY-MM-DD）；都没有 → 不按周过滤。
     周日晚推下周一即靠「对明天日期重新算周次」自然处理（跨周时周次 +1）。 */
  function rowDayNum(row) {
    var d = row.day != null ? row.day : row.weekday;
    if (d === "" || d == null) return null;
    if (typeof d === "number") return d === 0 ? 0 : (d >= 1 && d <= 7 ? d % 7 : null);
    var s = String(d).trim();
    var cn = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 };
    var m = s.match(/[周星期礼拜]([一二三四五六日天])/);
    if (m) return cn[m[1]];
    var en = s.match(/^(mon|tue|wed|thu|fri|sat|sun)/i);
    if (en) return { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 }[en[1].toLowerCase()];
    var n = parseInt(s, 10);
    if (isFinite(n)) return n === 0 ? 0 : (n >= 1 && n <= 7 ? n % 7 : null);
    return null;
  }

  function matchesDay(row, date) {
    var d = rowDayNum(row);
    if (d == null) return true; // 未标注星期 → 每天
    return d === date.getDay();
  }

  /* ---------------- 学期起点与当前周数 ---------------- */
  var semesterStart = ""; // 运行时注入（user_settings.semester_start）

  function normDateStr(s) {
    var m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }
  // 注入学期第一周周一日期（chat.js 用）；同时写入 localStorage 兜底
  function setSemesterStart(s) {
    semesterStart = normDateStr(s);
    try {
      if (semesterStart) localStorage.setItem("campus_semester_start", semesterStart);
      else localStorage.removeItem("campus_semester_start");
    } catch (_) {}
  }
  function getSemesterStart() {
    if (semesterStart) return semesterStart;
    try { return localStorage.getItem("campus_semester_start") || ""; } catch (_) { return ""; }
  }
  // date 所在周是学期第几周（学期开始前返回 null；未设学期起点返回 null）
  function semesterWeek(date) {
    var start = getSemesterStart();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
    var s = new Date(start + "T00:00:00");
    if (isNaN(s.getTime())) return null;
    var d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var diff = Math.floor((d0.getTime() - s.getTime()) / 86400000);
    if (diff < 0) return null;
    return Math.floor(diff / 7) + 1;
  }
  function currentWeek(date) { return semesterWeek(date || new Date()); }

  /* ---------------- 周次解析（与 ScheduleCore.parseWeeks 同规则） ----------------
     返回 { start, end, type, nums }：nums 为文本列出的全部周次（精确匹配用），
     无数字时 nums=null（如「单周」→ 只按单双周判断）。 */
  function parseWeeks(s) {
    var out = { start: null, end: null, type: "all", nums: null };
    var str = String(s == null ? "" : s).trim();
    if (!str) return out;
    if (str.indexOf("单") > -1) out.type = "odd";
    else if (str.indexOf("双") > -1) out.type = "even";
    var nums = [];
    var re = /(\d+)\s*[-~至到]\s*(\d+)|(\d+)/g;
    var m;
    while ((m = re.exec(str))) {
      if (m[1]) { for (var i = +m[1]; i <= +m[2]; i++) nums.push(i); }
      else nums.push(+m[3]);
    }
    if (nums.length) {
      out.nums = nums;
      out.start = Math.min.apply(null, nums);
      out.end = Math.max.apply(null, nums);
    }
    return out;
  }

  // 行是否有任何周次信息（文本或结构化字段）
  function rowWeekInfo(row, weeksStr) {
    var sw = row ? parseInt(row.start_week, 10) : NaN;
    var ew = row ? parseInt(row.end_week, 10) : NaN;
    var wt = row ? String(row.week_type || "").trim() : "";
    // 始终从 weeks 文本解析精确周次列表（处理「3-7,13」这类拆开/不连续周次）：
    // 即便结构化字段把它压成了连续起止区间，也用文本列表精确排除空隙周，避免误推。
    var pText = parseWeeks(weeksStr != null ? weeksStr : (row && row.weeks));
    var textNums = (pText && pText.nums) ? pText.nums : null;
    var hasStruct = isFinite(sw) || isFinite(ew) || (wt && wt !== "all");
    if (!hasStruct) {
      return { start: pText.start, end: pText.end, type: pText.type, nums: textNums, hasInfo: !!(textNums || pText.type !== "all") };
    }
    return {
      start: isFinite(sw) ? sw : null,
      end: isFinite(ew) ? ew : null,
      type: (wt === "odd" || wt === "even") ? wt : "all",
      nums: textNums, // 文本含不连续周次时，用精确列表覆盖起止范围判断
      hasInfo: true
    };
  }

  // 判断某课程在 date 所在周是否上课
  // weeksStr / row 至少传一个；row 存在时结构化字段优先
  function weekMatches(weeksStr, date, row) {
    var info = row ? rowWeekInfo(row, weeksStr) : (function () {
      var p = parseWeeks(weeksStr);
      return { start: p.start, end: p.end, type: p.type, nums: p.nums, hasInfo: !!(p.nums || p.type !== "all") };
    })();
    if (!info.hasInfo) return true;                 // 没有任何周次信息 → 每周都上
    var w = semesterWeek(date);
    if (w == null) return true;                     // 未设学期起点 → 不按周过滤
    if (info.nums && info.nums.indexOf(w) === -1) return false; // 文本列表精确匹配
    if (info.start != null && w < info.start) return false;
    if (info.end != null && w > info.end) return false;
    if (info.type === "odd" && w % 2 === 0) return false;
    if (info.type === "even" && w % 2 === 1) return false;
    return true;
  }

  /* ---------------- 防重复推送缓存 ---------------- */
  function loadState() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(PUSH_KEY) || "null"); } catch (_) {}
    var day = dayKey(new Date());
    if (!s || s.day !== day || !s.shown) s = { day: day, shown: {} }; // 新的一天 → 清空重来
    return s;
  }
  function saveState(s) {
    try { localStorage.setItem(PUSH_KEY, JSON.stringify(s)); } catch (_) {}
  }

  /* ---------------- 课程筛选：当天的后续课程（+ 晚间次日第一节课） ---------------- */
  function keyOf(row, isToday) {
    return (isToday ? "today" : "tomorrow") + "|" + row.idx + "|" + (row.course_name || "") + "|" + (window.ScheduleCore.effectiveStart(row));
  }

  function computeUpcoming(now) {
    now = now || new Date();
    var rows = (window.ScheduleCore.getRows() || []).filter(function (r) { return r && r.start_time; });

    // 白天：当天后续课程（开始时间晚于当前时刻）
    var todayLeft = rows
      .filter(function (r) { return matchesDay(r, now) && weekMatches(r.weeks, now, r); })
      .filter(function (r) { return minOf(hm(window.ScheduleCore.effectiveStart(r))) > nowMin(now); })
      .sort(function (a, b) { return minOf(hm(window.ScheduleCore.effectiveStart(a))) - minOf(hm(window.ScheduleCore.effectiveStart(b))); });

    var list = todayLeft.map(function (r) {
      return { row: r, isToday: true, startDT: atTime(now, hm(window.ScheduleCore.effectiveStart(r))), key: keyOf(r, true) };
    });

    // 晚上（18:00 起）：追加次日第一节课（周日晚 → 下周一，跨周自动换算周次）
    if (now.getHours() >= EVENING_HOUR) {
      var tm = addDays(now, 1);
      var tmRows = rows
        .filter(function (r) { return matchesDay(r, tm) && weekMatches(r.weeks, tm, r); })
        .sort(function (a, b) { return minOf(hm(window.ScheduleCore.effectiveStart(a))) - minOf(hm(window.ScheduleCore.effectiveStart(b))); });
      if (tmRows.length) {
        var r0 = tmRows[0];
        list.push({ row: r0, isToday: false, startDT: atTime(tm, hm(window.ScheduleCore.effectiveStart(r0))), key: keyOf(r0, false) });
      }
    }
    return list;
  }

  /* ---------------- 通勤卡片渲染（复用 #commuteCardTpl） ---------------- */
  function setRow(node, label, text) {
    node.querySelectorAll(".commute-row").forEach(function (row) {
      var l = row.querySelector(".label");
      var v = row.querySelector(".value");
      if (l && v && l.textContent.trim() === label && v.textContent !== text) v.textContent = text;
    });
  }
  function rowValue(node, label) {
    var rows = node.querySelectorAll(".commute-row");
    for (var i = 0; i < rows.length; i++) {
      var l = rows[i].querySelector(".label");
      var v = rows[i].querySelector(".value");
      if (l && v && l.textContent.trim() === label) return v.textContent;
    }
    return "";
  }

  function fillCardBasic(node, item) {
    setRow(node, "课程名", item.row.course_name || "—");
    setRow(node, "开始时间", window.ScheduleCore.effectiveStart(item.row) + (item.isToday ? "" : "（明天）"));
    setRow(node, "教室位置", item.row.location || "待定");
  }

  function createCard(item) {
    var tpl = document.getElementById("commuteCardTpl");
    var node = tpl.content.cloneNode(true).firstElementChild; // .msg.agent
    node.querySelectorAll("[id]").forEach(function (el) { el.removeAttribute("id"); }); // 多张卡片不能有重复 id
    node._item = item;
    fillCardBasic(node, item);
    var badge = node.querySelector(".cc-badge");
    if (badge) badge.textContent = item.isToday ? "本日" : "明日"; // 徽章与卡片事实对应
    var timeEl = node.querySelector(".time");
    if (timeEl) timeEl.textContent = hhmm(new Date());
    return node;
  }

  function appendNode(node) {
    var box = document.getElementById("messageList");
    if (box) box.appendChild(node);
    var scroll = document.getElementById("chatScroll");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }

  // 仅主卡（第一条 / 时间最早）展示「天气提醒」行与【现在出发】按钮，其余隐藏
  function hideEl(el, hidden) {
    if (!el) return;
    if (el.style) el.style.display = hidden ? "none" : "";
    else el.hidden = !!hidden; // 兼容无 style 的测试桩
  }
  function applyPrimary(node, isPrimary) {
    if (!node) return;
    node.querySelectorAll(".commute-row").forEach(function (r) {
      var l = r.querySelector(".label");
      if (l && l.textContent.trim() === "天气提醒") hideEl(r, !isPrimary);
    });
    var btn = node.querySelector(".depart-btn");
    if (btn) hideEl(btn, !isPrimary);
  }

  /* ---------------- 实时通勤数据（第四步 API，按卡片独立计算 + 缓存） ---------------- */
  function formVal(id, dft) {
    var el = document.getElementById(id);
    var v = el ? String(el.value || "").trim() : "";
    return v || dft || "";
  }
  function currentOrigin() { return formVal("set-depart", "梅园 3 栋 518"); }
  function currentSchool() { return formVal("set-school", ""); }   // 大学所在地（天气取此）
  function currentMode() { return formVal("set-mode", "步行"); }

  // 仅第一条（primary）展示天气 + 现在出发按钮；其余课程卡只给路上耗时
  function computeCard(node, item, isPrimary) {
    isPrimary = !!isPrimary;
    setRow(node, "路上耗时", "计算中…");
    setRow(node, "天气提醒", "—");
    if (!window.CommuteAPI) {
      setRow(node, "路上耗时", DEMO_TRAVEL);
      if (isPrimary) setRow(node, "天气提醒", DEMO_WEATHER);
      return;
    }
    var seq = (node._seq = (node._seq || 0) + 1); // 丢弃过期响应
    var room = (item.row.location || "").trim();
    var origin = currentOrigin();           // 通勤耗时：出发地 → 教室
    var school = currentSchool();           // 天气取「大学所在地」
    var wLoc = school || origin;            // 未填学校时回退出发地
    var mode = currentMode();
    var hours = item.isToday ? 6
      : Math.max(6, Math.ceil((item.startDT.getTime() - Date.now()) / 3600000) + 2);
    var tKey = origin + "|" + room + "|" + mode;
    var wKey = wLoc + "|" + hours;

    // 缓存 Promise 本身（而非结果）：多张卡片同时建卡时，同一 key 只发一次请求；
    // 失败时清掉缓存，下次渲染可重试。天气仅第一条卡需要，故只为主卡拉取。
    if (!travelCache[tKey]) {
      travelCache[tKey] = window.CommuteAPI.getCommuteDetail(origin, room, mode)
        .catch(function (e) { delete travelCache[tKey]; throw e; });
    }
    var tasks = [travelCache[tKey]];
    if (isPrimary) {
      if (!weatherCache[wKey]) {
        weatherCache[wKey] = window.CommuteAPI.checkWeather(wLoc, { hours: hours })
          .then(function (w) { return { text: w.text }; })
          .catch(function (e) { delete weatherCache[wKey]; throw e; });
      }
      tasks.push(weatherCache[wKey]);
    }

    // 任一部分失败只回退该部分，互不影响；都失败则完整保留演示值
    Promise.allSettled(tasks).then(function (rs) {
      if (node._seq !== seq || !node.isConnected) return;
      if (rs[0].status === "fulfilled") setRow(node, "路上耗时", rs[0].value.minutes + " 分钟");
      else setRow(node, "路上耗时", DEMO_TRAVEL);
      if (isPrimary) {
        if (rs[1] && rs[1].status === "fulfilled" && rs[1].value && rs[1].value.text) {
          setRow(node, "天气提醒", rs[1].value.text);
        } else {
          setRow(node, "天气提醒", DEMO_WEATHER);
        }
      }
    });
  }

  /* ---------------- 推送气泡文案 ---------------- */
  function greet(d) {
    var h = d.getHours();
    if (h < 6) return "夜深了";
    if (h < 11) return "早上好";
    if (h < 13) return "中午好";
    if (h < 18) return "下午好";
    return "晚上好";
  }

  function pushBubbleText(fresh, now) {
    var todays = fresh.filter(function (i) { return i.isToday; });
    var tomorrows = fresh.filter(function (i) { return !i.isToday; });
    var parts = [];
    // 当前周数（第六步：设了学期起点才显示）
    var w = semesterWeek(now);
    if (w != null) parts.push("本学期第 " + w + " 周");
    if (todays.length) parts.push("今天还剩 " + todays.length + " 节课");
    if (tomorrows.length) {
      if (!todays.length) parts.push("今天的课都结束了");
      var t = tomorrows[0];
      var wTm = semesterWeek(addDays(now, 1));
      var cross = (wTm != null && wTm !== w) ? "（进入第 " + wTm + " 周）" : "";
      parts.push("明天第一节课是《" + (t.row.course_name || "") + "》（" + window.ScheduleCore.effectiveStart(t.row) + "）" + cross);
    }
    return greet(now) + "！" + parts.join("，") + "，通勤安排帮你列好了 👇";
  }

  /* ---------------- 模块一主入口：渲染（幂等） ---------------- */
  function render(opts) {
    opts = opts || {};
    if (!window.ScheduleCore) return;
    if (!scheduleConfirmed) return; // 课表未确认前不弹出任何课程 / 通勤信息
    var now = new Date();
    var upcoming = computeUpcoming(now);
    var state = loadState();

    // 1) 气泡：只对「本次新出现」的课程输出（防重复推送的核心）
    var fresh = upcoming.filter(function (i) { return !state.shown[i.key]; });
    if (fresh.length) {
      if (!opts.silent) appendAgentText(pushBubbleText(fresh, now));
      fresh.forEach(function (i) { state.shown[i.key] = Date.now(); });
      saveState(state);
    }

    // 2) 卡片：按 key 复用更新；新课建卡并计算实时数据；已开始/已删的课移除卡片
    //     仅时间最早的第一条（primary）展示天气 + 现在出发按钮，其余只显示路上耗时
    var primaryKey = upcoming.length ? upcoming[0].key : null;
    var alive = {};
    upcoming.forEach(function (item) {
      alive[item.key] = true;
      var isPrimary = item.key === primaryKey;
      var node = cardMap[item.key];
      if (!node || !node.isConnected) {
        node = createCard(item);
        cardMap[item.key] = node;
        appendNode(node);
        computeCard(node, item, isPrimary);
      } else {
        fillCardBasic(node, item); // 课程/时间/教室可能被改过 → 就地刷新
        if (opts.recompute) computeCard(node, item, isPrimary);
        // 主卡身份变化（前面的课结束，本卡升为第一条）→ 重新拉取天气
        else if (isPrimary && node._isPrimary !== true) computeCard(node, item, isPrimary);
      }
      applyPrimary(node, isPrimary);
      node._isPrimary = isPrimary;
    });
    Object.keys(cardMap).forEach(function (k) {
      if (!alive[k]) {
        if (cardMap[k] && cardMap[k].remove) cardMap[k].remove();
        delete cardMap[k];
      }
    });

    startTimer();
  }

  // 页面持续打开：定期复查（课程开始 / 跨天 / 进入晚间 → 自动换表或推送新课）
  function startTimer() {
    if (timer) return;
    timer = setInterval(function () { render(); }, 45000);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") render();
    });
  }

  /* ---------------- 模块二：现在出发 ---------------- */
  function departFromCard(btn) {
    var node = btn && btn.closest ? btn.closest(".msg.agent") : null;
    var item = node && node._item;
    if (!item) return;

    var travelText = rowValue(node, "路上耗时") || "";
    if (/计算中|^—$/.test(travelText)) {
      appendAgentText("正在为你计算实时通勤时间，请稍候再点一次「现在出发」⏳");
      return;
    }
    var travelMin = parseInt(String(travelText).replace(/\D/g, ""), 10);
    if (!isFinite(travelMin)) travelMin = 0;

    var now = new Date();
    var arrival = new Date(now.getTime() + travelMin * 60000);
    var name = item.row.course_name || "这节课";
    var msg;

    if (item.isToday) {
      // 今天的课：预计到达时间 + 多余时间
      var extra = Math.round((item.startDT.getTime() - arrival.getTime()) / 60000);
      if (extra >= 0) {
        msg = "路上注意安全，预计 " + hhmm(arrival) + " 到达，比上课提前 " + extra + " 分钟，" +
              (extra >= 5 ? "时间充裕" : "刚好赶得上") + "。";
      } else {
        msg = "路上注意安全，预计 " + hhmm(arrival) + " 到达，已晚于上课时间 " + Math.abs(extra) + " 分钟，快走！";
      }
    } else {
      // 明天的课：给出建议出发时间（按路上耗时算，到达上课时间即可，不额外预留提前量）
      var leaveBy = new Date(item.startDT.getTime() - travelMin * 60000);
      msg = "《" + name + "》明天 " + window.ScheduleCore.effectiveStart(item.row) + " 开始，路上约 " + travelMin + " 分钟，" +
            "建议明天 " + hhmm(leaveBy) + " 出发。";
    }
    appendAgentText(msg);
  }

  // 对话框自然语言「现在出发」→ 对下一节（列表中第一张）课程执行
  function departForNext() {
    var box = document.getElementById("messageList");
    var card = box && box.querySelector(".msg.agent .commute-card");
    var wrap = card && card.closest(".msg.agent");
    var btn = wrap && wrap.querySelector(".depart-btn");
    if (btn) departFromCard(btn);
    else appendAgentText("今天没有需要通勤的课程啦，好好休息～");
  }

  // 卡片内【现在出发】按钮（事件委托；模板里的 id 已在克隆时剥掉，改按类名找）
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest(".depart-btn") : null;
    if (btn) departFromCard(btn);
  });

  return {
    render: render,
    refresh: render, // 别名：chat.js 的 syncCommuteCardFromSchedule 调用
    departFromCard: departFromCard,
    departForNext: departForNext,
    computeUpcoming: computeUpcoming,
    matchesDay: matchesDay,
    weekMatches: weekMatches,
    keyOf: keyOf,
    parseWeeks: parseWeeks,
    rowWeekInfo: rowWeekInfo,
    semesterWeek: semesterWeek,
    currentWeek: currentWeek,
    setSemesterStart: setSemesterStart,
    getSemesterStart: getSemesterStart,
    setConfirmed: setConfirmed,
    isConfirmed: isConfirmed,
    clearCommuteCards: clearCommuteCards
  };
})();
