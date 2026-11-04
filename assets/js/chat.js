/* ===================================================================
   聊天首页脚本
   - 对话渲染 / 课表核对 / 设置弹窗“按需局部更新”
   - 第五步「自动推送 + 现在出发」在 assets/js/auto-push.js：
       首屏与课表/设置变化时调用 syncCommuteCardFromSchedule() 刷新
       「今日后续课程」通勤卡片（幂等，不会重复渲染同一张卡）
   - 第六步（单双周 / 起止周次）：学期第一周周一日期 semester_start
       随基础设置保存；加载/保存后注入 auto-push.js（setSemesterStart），
       由它按当前周数判断每门课本周是否上课。
   - 第七步（智谱 GLM 意图识别）：assets/js/llm.js 封装 callLLM()，
       本文件的 dispatchUserText() 按 action 分发到既有逻辑，
       LLM 不可用时自动降级本地正则（isDepartIntent）。
   =================================================================== */

// 实时通勤计算的参数来源（默认出发地 / 通勤方式 / 学校（含校区）/ 学期起点，
// 来自用户设置；未配置时回退读设置表单的当前值，表单本身有演示默认值）
const commuteMeta = { origin: "", mode: "步行", school: "", semester: "" };

// 把学校同步给 API 层（高德地理编码按「学校+教学楼/宿舍」拼名定位；
// 学校是单个字段，有校区就写在一起，如「北京大学昌平校区」）
function syncSchoolContext() {
  if (window.CommuteAPI && window.CommuteAPI.setSchoolContext) {
    window.CommuteAPI.setSchoolContext(commuteMeta.school);
  }
}

// 把学期第一周周一日期同步给自动推送层（第六步：计算当前周数、判断单双周）
// 传空值 = 用户显式清空（设置保存路径会传 ""，用于清除）；加载路径只在
// 确有取值时调用，避免误删演示模式 localStorage 里的兜底值。
function syncSemesterContext(value) {
  if (window.AutoPush && window.AutoPush.setSemesterStart) {
    window.AutoPush.setSemesterStart(value === undefined ? commuteMeta.semester : value);
  }
}

// 日期归一化：取 YYYY-MM-DD（云端 DATE 列 / date 输入框都是这个格式）
function normDateStr(s) {
  const m = String(s || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

/* ===================================================================
   第五步：自动推送 + 「现在出发」交互 → assets/js/auto-push.js
   - render(opts)：按当前时间/星期/课表渲染「今日后续课程」通勤卡片，
     幂等（同一课程不会重复建卡）；opts.recompute=重算实时数据，
     opts.silent=只更新表格不推送气泡。
   - 课表变化、设置保存（出发地/方式/学校变了）后调用本函数刷新。
   =================================================================== */
function syncCommuteCardFromSchedule(opts) {
  if (window.AutoPush) window.AutoPush.render(opts);
}

// 工具：转义，避免课名中的特殊字符破坏 HTML
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// 工具：智能体发一句纯文本
function appendAgentText(text) {
  const box = document.getElementById("messageList");
  const scroll = document.getElementById("chatScroll");
  if (!box) return;
  const t = new Date().toTimeString().slice(0, 5);
  const wrap = document.createElement("div");
  wrap.className = "msg agent";
  wrap.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="bubble">
      <p></p>
      <span class="time">${t}</span>
    </div>`;
  wrap.querySelector("p").textContent = text;
  box.appendChild(wrap);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

// 工具：智能体发一句带链接的文本（用于首次配置引导）
function appendAgentLink(label, href) {
  const box = document.getElementById("messageList");
  const scroll = document.getElementById("chatScroll");
  if (!box) return;
  const t = new Date().toTimeString().slice(0, 5);
  const wrap = document.createElement("div");
  wrap.className = "msg agent";
  wrap.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="bubble">
      <p></p>
      <span class="time">${t}</span>
    </div>`;
  const p = wrap.querySelector("p");
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label;
  p.appendChild(a);
  box.appendChild(wrap);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

// ---- 课表核对卡片：解析结果表格，可逐行/自然语言修改 ----
// 内存真值在 ScheduleCore.state.rows（云端 schedule_data 的本地镜像）；
// 逐行编辑 / 自然语言修改都改它。对话页的核对卡 persist=1：改动即时落库。
function appendScheduleVerify() {
  const box = document.getElementById("messageList");
  const scroll = document.getElementById("chatScroll");
  if (!box || !window.ScheduleCore) return;
  const card = window.ScheduleCore.renderVerifyCard({
    rows: window.ScheduleCore.getRows(),
    persist: true,
    onConfirm: function () { confirmSchedule(); }
  });
  box.appendChild(card);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

// 把当前课表数据同步回核对表里的输入框（自然语言修改后调用）
function updateVerifyInputs() {
  if (window.ScheduleCore) window.ScheduleCore.syncInputs(document);
}

// 归一化入口（保留旧函数名，内部走共享核心）
function normalizeSchedule(rows) {
  return window.ScheduleCore ? window.ScheduleCore.normalize(rows) : rows;
}

// 写回云端课表（仅 schedule_data）
function persistSchedule() {
  if (window.AppData && window.AppData.saveSchedule) {
    window.AppData.saveSchedule(window.ScheduleCore.getRows()).catch((e) => console.error("[schedule] 保存失败", e));
  }
}

// 自然语言修改课表（对话输入框）：识别「第 N 节 … 开始/结束 … HH:MM」等
function applyScheduleEdit(text) {
  if (!window.ScheduleCore) return null;
  const res = window.ScheduleCore.parseEdit(text);
  if (!res) return null;
  updateVerifyInputs();
  persistSchedule();
  // 课表时间/教室变了 → 静默刷新通勤卡片（换卡不重复推送气泡）
  syncCommuteCardFromSchedule({ silent: true });
  return res.ack + (res.ok ? " 确认无误后点「✅ 确认无误，保存课表」即可。" : "");
}

// 确认保存课表（对话页核对卡）
function confirmSchedule() {
  persistSchedule();
  // 用户已确认 → 解锁并刷新通勤提醒
  if (window.AutoPush) window.AutoPush.setConfirmed(true);
  syncCommuteCardFromSchedule({ recompute: true });
  appendAgentText("✅ 已保存你的课表！之后我会按这些时间为你生成每日通勤提醒。如需改动，随时在「设置修改」里重新上传课表。");
}

// 首屏对话内容由第五步 AutoPush 自动推送生成（今日后续课程 + 通勤卡片），
// 不再渲染假历史；见 assets/js/auto-push.js。

// “现在出发”意图识别（第五步模块二）：按钮点击由 auto-push.js 的事件委托处理；
// 这里是对话框自然语言的本地正则版——第七步起主要作为 LLM 不可用时的降级兜底
window.isDepartIntent = (text) =>
  /(现在出发|马上出发|准备出发|出发吧|出发啦|出发了|我出发了|该走了|走吧|走咯|走喽|去上课|出门了|出门咯|出门|我要出门)/.test(text);

/* ===================================================================
   第七步：智谱 GLM 意图识别 → action 分发（assets/js/llm.js）
   - LLM 可用：callLLM(text) 返回 {action, mode?}，按 action 触发
     第五步的「现在出发」/ 通勤方式切换 / 天气问答；
   - LLM 不可用（未配 Key / 请求失败 / 超时 / 返回无法识别）：
     自动降级到本地正则 + 课表修改链路，功能不断。
   =================================================================== */

// 通勤方式映射：LLM 英文 code ↔ 设置表单中文选项（与 #set-mode 对齐）
window.MODE_LABEL = { walking: "步行", cycling: "骑行", transit: "校内公交" };
window.MODE_CODE = { "步行": "walking", "骑行": "cycling", "校内公交": "transit" };

// LLM 调用期间的「思考中」临时气泡（复用既有 .msg.agent 样式，不新增 CSS）
function appendThinking() {
  const box = document.getElementById("messageList");
  const scroll = document.getElementById("chatScroll");
  if (!box) return null;
  const t = new Date().toTimeString().slice(0, 5);
  const wrap = document.createElement("div");
  wrap.className = "msg agent";
  wrap.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="bubble">
      <p>🔍 正在识别课表（约需 10–30 秒，请保持本页面前台、屏幕常亮）…</p>
      <span class="time">${t}</span>
    </div>`;
  box.appendChild(wrap);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
  return wrap;
}
function removeThinking(node) { if (node && node.remove) node.remove(); }

// LLM 判定要改通勤方式 → 同步表单 / 内存 / 云端（只改 commute_mode），重算卡片
async function applyModeChange(mode) {
  const label = MODE_LABEL[mode];
  if (!label) return;
  commuteMeta.mode = label;
  const sel = document.getElementById("set-mode");
  if (sel) {
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].text === label || sel.options[i].value === label) { sel.selectedIndex = i; break; }
    }
  }
  // 持久化：读当前设置 → 合并 commute_mode 一列 → 保存（不碰其它字段）
  if (window.AppData && window.AppData.saveSettings) {
    try {
      let cur = null;
      try { cur = await window.AppData.loadSettings(); } catch (e) {}
      const merged = Object.assign({}, cur || {}, { commute_mode: label });
      await window.AppData.saveSettings(merged);
      settingsSnapshot = snapshotFromSettings(merged);
    } catch (e) { console.error("[mode] 保存失败", e); }
  }
  syncCommuteCardFromSchedule({ recompute: true });
  appendAgentText("好，已切换到「" + label + "」，通勤卡片按新方式重新算好了 🚶");
}

// LLM 判定在问天气 → 用第四步的天气 API 直接回答（优先取「大学所在地」）
async function replyWeather() {
  const dep = document.getElementById("set-depart");
  const origin = (commuteMeta.origin || "").trim() || (dep ? dep.value.trim() : "");
  const school = (commuteMeta.school || "").trim();
  const loc = school || origin;
  if (!loc) { appendAgentText("先在设置里填好学校或默认出发地，我才能查天气～"); return; }
  try {
    const w = await window.CommuteAPI.checkWeather(loc, { hours: 6 });
    appendAgentText((w && w.text) || "暂无数据");
  } catch (e) {
    if (e && e.quotaExceeded) { appendAgentText("⚠️ " + ((e && e.message) || "今日免费额度已用完")); return; }
    appendAgentText("天气没查出来（" + ((e && e.message) || "网络异常") + "），出门记得看一眼天空 ☁️");
  }
}

// ---- 通勤耗时查询（第七步扩展：query_commute）----
// 本地小工具：HH:MM 比较 / 当前 HH:MM / 日期加天
function _hmToMin(s) {
  const m = String(s || "").match(/(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : NaN;
}
function _nowHmStr(d) {
  d = d || new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function _addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function _hhmm(d) {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// 从课表里挑出「目标课」：course 优先（今天→明天→任意），否则按 when 取
// when: today_evening=今天最后一节 / today_next=今天接下来最近一节 / tomorrow_first=明天第一节 / today=同 today_next
// 返回 { row, isToday } 或 null（依赖 window.ScheduleCore + window.AutoPush 的星期/周次匹配）
function resolveCommuteTarget(spec) {
  if (!window.ScheduleCore) return null;
  spec = spec || {};
  const now = new Date();
  const rows = (window.ScheduleCore.getRows() || []).filter((r) => r && r.start_time);
  const matchDay = (r, date) =>
    (!window.AutoPush || (window.AutoPush.matchesDay(r, date) && window.AutoPush.weekMatches(r.weeks, date, r)));
  const byStart = (a, b) => _hmToMin(a.start_time) - _hmToMin(b.start_time);

  // 1) 按课程名
  if (spec.course) {
    const byName = rows.filter((r) => (r.course_name || "").indexOf(spec.course) > -1);
    let cand = byName.filter((r) => matchDay(r, now));
    if (!cand.length) cand = byName.filter((r) => matchDay(r, _addDays(now, 1)));
    if (!cand.length) cand = byName;
    if (cand.length) return { row: cand[0], isToday: matchDay(cand[0], now) };
  }

  const when = spec.when || "today_next";
  if (when === "tomorrow_first") {
    const tr = rows.filter((r) => matchDay(r, _addDays(now, 1))).sort(byStart);
    return tr.length ? { row: tr[0], isToday: false } : null;
  }
  const tRows = rows.filter((r) => matchDay(r, now)).sort(byStart);
  if (!tRows.length) return null;
  if (when === "today_evening") return { row: tRows[tRows.length - 1], isToday: true };
  // today_next：接下来最近一节（未开始）；都开始过则取最后一节
  const upcoming = tRows.filter((r) => _hmToMin(r.start_time) > _hmToMin(_nowHmStr(now)));
  return { row: (upcoming.length ? upcoming[0] : tRows[tRows.length - 1]), isToday: true };
}

// 计算并回复「从 origin 出发去某节课」的耗时 + 预计到达
async function replyCommute(spec) {
  const target = resolveCommuteTarget(spec || {});
  if (!target || !target.row) {
    appendAgentText("没找到对应的课～可以试着说「今天晚课从图书馆出发要多久」或「明天第一节从宿舍出发要多久」这样的说法。");
    return;
  }
  const origin = ((spec && spec.origin) || "").trim() || commuteMeta.origin;
  if (!origin) {
    appendAgentText("先告诉我从哪儿出发（比如「从图书馆出发」），并在设置里填好默认出发地，我才能算路线～");
    return;
  }
  const room = (target.row.location || "").trim();
  if (!room) {
    appendAgentText("《" + (target.row.course_name || "这节课") + "》的教室位置还没填，我算不了路线～");
    return;
  }
  const mode = commuteMeta.mode || "步行";
  const name = target.row.course_name || "这节课";
  try {
    const detail = await window.CommuteAPI.getCommuteDetail(origin, room, mode);
    const travelMin = detail.minutes;
    const now = new Date();
    const arrival = new Date(now.getTime() + travelMin * 60000);
    const startMin = _hmToMin(target.row.start_time);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const diff = isFinite(startMin) ? startMin - (nowMin + travelMin) : NaN;
    const head = "从「" + origin + "」到《" + name + "》教室（" + room + "），" +
      (detail.modeLabel || "") + "约 " + travelMin + " 分钟（" + (detail.distanceText || "") + "）。";
    let tail;
    if (isFinite(diff) && diff >= 0) {
      tail = "现在出发预计 " + _hhmm(arrival) + " 到达，距上课还有 " + diff + " 分钟。";
    } else if (isFinite(diff)) {
      tail = "现在出发预计 " + _hhmm(arrival) + " 到达，已晚于上课时间 " + Math.abs(diff) + " 分钟，快走！";
    } else {
      tail = "现在出发预计 " + _hhmm(arrival) + " 到达。";
    }
    appendAgentText(head + tail);
  } catch (e) {
    if (e && e.quotaExceeded) { appendAgentText("⚠️ " + ((e && e.message) || "今日免费额度已用完")); return; }
    appendAgentText("路线算不出来（" + ((e && e.message) || "网络异常") + "），换个说法或稍后再试～");
  }
}

// 本地兜底：识别「从 X 出发去某节课要多久 / 几点到」这类问法（无大模型也可用）
window.isCommuteQuery = function (text) {
  if (!/(要多久|多久|几点到|几点能到|到达时间|多少时间|所需时间|要多少时间|怎么到|怎么去)/.test(text)) return null;
  const m = text.match(/从\s*(.+?)\s*(?:出发|到|去)/);
  const origin = m ? m[1].trim() : "";
  let when = "today_next", course = "";
  if (/晚课|晚上|今晚|夜里|后两节|后半/.test(text)) when = "today_evening";
  else if (/明天|次日/.test(text)) when = "tomorrow_first";
  else if (/下节|接下来|下一节|最近|这节|本节课/.test(text)) when = "today_next";
  else when = "today_next";
  // 课程名关键词：捕获「《X》」或「去/上 X 课」里的名词
  const c = text.match(/《([^》]+)》/) || text.match(/(?:去|上|到)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,8})\s*课/);
  if (c) course = c[1].trim();
  return { origin: origin, when: when, course: course };
};

// 用户输入统一入口：LLM 优先，本地兜底
async function dispatchUserText(text) {
  const think = (window.LLM && window.LLM.isReady()) ? appendThinking() : null;
  let llmTried = false; // 配了 Key 并尝试调用
  let llmOk = false;    // LLM 成功返回（含 none）

  if (think) {
    llmTried = true;
    try {
      const r = await window.LLM.callLLM(text, {
        context: {
          mode: commuteMeta.mode || "步行",
          nowText: new Date().toTimeString().slice(0, 5),
        },
      });
      llmOk = true;
      if (r && r.action === "depart_now") {
        removeThinking(think);
        if (window.AutoPush) window.AutoPush.departForNext();
        return;
      }
      if (r && r.action === "change_mode" && r.mode) {
        removeThinking(think);
        await applyModeChange(r.mode);
        return;
      }
      if (r && r.action === "query_weather") {
        removeThinking(think);
        await replyWeather();
        return;
      }
      if (r && r.action === "query_commute") {
        removeThinking(think);
        await replyCommute({ origin: r.origin, when: r.when, course: r.course });
        return;
      }
      // action=none：LLM 认为与通勤无关 → 移除思考气泡，继续走本地链路
      removeThinking(think);
    } catch (e) {
      // 配额耗尽：直接提示，不再降级（避免继续消耗外部 API）
      if (e && e.quotaExceeded) {
        removeThinking(think);
        appendAgentText("⚠️ " + ((e && e.message) || "今日免费额度已用完"));
        return;
      }
      console.warn("[llm] 调用失败，降级到本地识别：", (e && e.message) || e);
      removeThinking(think);
    }
  }

  // 本地链路 1：「通勤耗时查询」正则（第七步扩展，先于出发意图，避免「从 X 出发去上课」误判）
  if (window.isCommuteQuery) {
    const q = window.isCommuteQuery(text);
    if (q) {
      setTimeout(() => { replyCommute(q); }, 400);
      return;
    }
  }

  // 本地链路 2：「现在出发」正则（第五步模块二）
  if (window.isDepartIntent && window.isDepartIntent(text)) {
    setTimeout(() => { if (window.AutoPush) window.AutoPush.departForNext(); }, 400);
    return;
  }

  // 本地链路 3：自然语言修改课表（如“第 2 节结束时间改成 15:40”）
  const editAck = applyScheduleEdit(text);
  if (editAck) {
    setTimeout(() => appendAgentText(editAck), 400);
    return;
  }

  // 本地链路 4：回执（按 LLM 实际状态给准确文案）
  let fallbackText;
  if (llmOk) fallbackText = "我没理解这句和通勤有关的意思，试试说「现在出发」或「我想走路」～";
  else if (llmTried) fallbackText = "网络似乎开小差了，没接住这句，试试说「现在出发」或「我想走路」～";
  else fallbackText = "收到～（演示模式：暂未接入真实数据）";
  setTimeout(() => {
    const reply = document.createElement("div");
    reply.className = "msg agent";
    reply.innerHTML = `
      <div class="avatar">🤖</div>
      <div class="bubble">
        <p>${fallbackText}</p>
        <span class="time">${new Date().toTimeString().slice(0, 5)}</span>
      </div>`;
    const box = document.getElementById("messageList");
    const scroll = document.getElementById("chatScroll");
    if (box) box.appendChild(reply);
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, 400);
}

// ---- 课表图片上传 → 真实 AI 识别 → 对话流核对卡片 ----
// 两种入口都统一：识别后把核对卡片作为「对话气泡」插入聊天流，
// 卡片 persist=1（改动即时落库），点「确认保存」即写入并刷新通勤卡。
// opts.fromSettings=true：来自设置弹窗，识别前先收起弹窗，核对卡落在对话里。
async function recognizeAndVerify(f, opts) {
  opts = opts || {};
  var fromSettings = !!opts.fromSettings;
  if (!window.LLM || !window.LLM.isReady()) {
    appendAgentText("（未配置智谱大模型代理，暂无法识别图片。请在 config.js 的 ZHIPU_CONFIG.proxyUrl 填入 Cloudflare Worker 地址，并确保 Worker 已配置 ZHIPU_KEY。）");
    return;
  }
  var think = appendThinking();
  var rows;
  try {
    rows = await window.LLM.recognizeSchedule(f);
  } catch (e) {
    removeThinking(think);
    console.error("[识别] 失败详情（含原始错误）：", e);
    if (e && e.quotaExceeded) appendAgentText("⚠️ " + ((e && e.message) || "今日免费额度已用完"));
    else appendAgentText("课表识别失败了：" + window.diagnoseProxyError(e && e.message) + " 😣");
    return;
  }
  removeThinking(think);
  if (!rows || !rows.length) {
    appendAgentText("没从图片里认出课程，换个角度或清晰点的图再来试试～");
    return;
  }
  window.ScheduleCore.setRows(rows, "image");
  var box = document.getElementById("messageList");
  var scroll = document.getElementById("chatScroll");

  // 新课表进入“待确认”状态：确认前不弹出任何通勤 / 课程提醒
  if (window.AutoPush) { window.AutoPush.setConfirmed(false); window.AutoPush.clearCommuteCards(); }

  // 确认动作（对话页与设置弹窗共用）
  var onConfirmSchedule = function (finalRows, cardNode) {
    window.ScheduleCore.setRows(finalRows, "image");
    persistSchedule();
    // 用户已确认 → 解锁并刷新通勤提醒
    if (window.AutoPush) window.AutoPush.setConfirmed(true);
    syncCommuteCardFromSchedule({ recompute: true });
    appendAgentText("✅ 已保存课表！之后我会按这些时间为你生成每日通勤提醒。需要改动随时在「设置修改」里重新上传。");
    // 标记该核对卡已确认，重传新课表时不会被当作“旧的未确认卡”清掉
    if (cardNode) cardNode.setAttribute("data-verified", "1");
  };

  // 来自设置弹窗：先收起弹窗，核对卡直接在对话流展示
  if (fromSettings && window.CampusCommute && window.CampusCommute.hideSettings) {
    window.CampusCommute.hideSettings();
  }

  // persist=1（改动即时落库），确认时再显式保存一次并刷新通勤卡片
  var card = window.ScheduleCore.renderVerifyCard({
    rows: rows,
    persist: true,
    headText: fromSettings ? "📋 新课表核对" : "📋 课表核对",
    descText: "我已识别你上传的课表，请核对每节课的星期、起止时间、教室与周次。表格内可直接改，也可用下方对话框以自然语言告诉我（如「第 2 节教室改成教三楼 302」）。确认无误点「确认保存」。",
    confirmText: "✅ 确认保存",
    onConfirm: onConfirmSchedule
  });
  // 重新上传新课表时，清掉对话流里旧的「未确认」核对卡，避免反复上传叠加多张
  // （已点过「确认保存」的历史核对卡带 data-verified，予以保留）
  if (box) {
    box.querySelectorAll(".verify-card").forEach(function (vc) {
      var msg = vc.closest(".msg.agent");
      if (msg && !msg.getAttribute("data-verified")) msg.remove();
    });
  }
  if (box) box.appendChild(card);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

// ---- 发送消息（仅前端占位，不发请求） ----
function bindComposer() {
  const input = document.getElementById("chatInput");
  const send = document.getElementById("sendBtn");
  const box = document.getElementById("messageList");
  const scroll = document.getElementById("chatScroll");
  if (!input || !send || !box) return;

  function sendMsg() {
    const text = input.value.trim();
    if (!text) return;
    const wrap = document.createElement("div");
    wrap.className = "msg user";
    const now = new Date().toTimeString().slice(0, 5);
    wrap.innerHTML = `
      <div class="avatar">🙂</div>
      <div class="bubble">
        <p></p>
        <span class="time">${now}</span>
      </div>`;
    wrap.querySelector("p").textContent = text;
    box.appendChild(wrap);
    input.value = "";
    scroll.scrollTop = scroll.scrollHeight;

    // 第七步：LLM 意图识别（智谱 GLM）→ 按 action 触发既有逻辑；
    // 未配置 Key / 请求失败 / 无法识别 → 自动降级到本地正则 + 课表修改链路
    dispatchUserText(text);
  }

  send.addEventListener("click", sendMsg);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });
}

/* ===================================================================
   模块三：设置弹窗 · 按需局部更新
   - 打开弹窗：拉取云端 user_settings 回填表单 + 记录快照，清空待处理课表
   - 脏检测：basicDirty（表单 ≠ 快照）/ scheduleDirty（上传新课表且已核对确认）
   - 保存：只写有改动的表（user_settings 与 schedule_data 互不触碰）
   =================================================================== */
let settingsSnapshot = null;

function readSettingsForm() {
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
  const c = (id) => { const el = document.getElementById(id); return !!(el && el.checked); };
  return {
    school: v("set-school").trim(),
    semester_start: normDateStr(v("set-semester")),
    default_departure: v("set-depart").trim(),
    commute_mode: v("set-mode"),
    weather_on: c("set-weather"),
  };
}

function fillSettingsForm(s) {
  if (!s) return;
  const d = document.getElementById("set-depart");
  const m = document.getElementById("set-mode");
  const w = document.getElementById("set-weather");
  const sc = document.getElementById("set-school");
  const ss = document.getElementById("set-semester");
  if (sc && s.school) sc.value = s.school;
  if (ss && s.semester_start) ss.value = normDateStr(s.semester_start);
  if (d && s.default_departure) d.value = s.default_departure;
  const selectByText = (sel, text) => {
    if (!sel || !text) return;
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].text === text || sel.options[i].value === text) { sel.selectedIndex = i; return; }
    }
  };
  selectByText(m, s.commute_mode);
  if (w) w.checked = !!s.weather_on;
}

function snapshotFromSettings(s) {
  if (!s) return null;
  return {
    school: s.school || "",
    semester_start: normDateStr(s.semester_start),
    default_departure: s.default_departure || "",
    commute_mode: s.commute_mode || "",
    weather_on: !!s.weather_on,
  };
}

function settingsBasicDirty() {
  if (!settingsSnapshot) return true; // 云端没有设置（或没加载到）→ 视为待保存
  const now = readSettingsForm();
  return Object.keys(settingsSnapshot).some((k) => String(now[k]) !== String(settingsSnapshot[k]));
}

async function openSettingsPanel() {
  let s = null;
  if (window.AppData && window.AppData.loadSettings) {
    try { s = await window.AppData.loadSettings(); } catch (e) { console.error(e); }
  }
  fillSettingsForm(s);
  settingsSnapshot = snapshotFromSettings(s);
  const fn = document.getElementById("settingsUploadFileName");
  if (fn) fn.textContent = "";
}

function bindSettingsPanel() {
  const openBtn = document.getElementById("openSettingsBtn");
  if (openBtn) openBtn.addEventListener("click", openSettingsPanel);

  // 顶栏「重置」：弹出自定义确认框（含红色警示），确认后才清空本机数据并回到配置页
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", openResetConfirm);
  }
  const resetModal = document.getElementById("resetConfirmModal");
  const resetCancel = document.getElementById("resetCancelBtn");
  const resetCancelX = document.getElementById("resetCancelXBtn");
  const resetConfirm = document.getElementById("resetConfirmBtn");
  if (resetCancel) resetCancel.addEventListener("click", closeResetConfirm);
  if (resetCancelX) resetCancelX.addEventListener("click", closeResetConfirm);
  if (resetConfirm) {
    resetConfirm.addEventListener("click", function () {
      closeResetConfirm();
      // 不动每日额度 cb_quota，只清设置与课表
      if (window.AppAuth && typeof window.AppAuth.resetLocalData === "function") {
        window.AppAuth.resetLocalData();
      }
    });
  }
  if (resetModal) {
    resetModal.addEventListener("click", function (e) {
      if (e.target === resetModal) closeResetConfirm(); // 点遮罩关闭
    });
  }

  // 设置页上传新课表 → 真实 AI 识别 → 待确认核对卡（不自动落库）
  const fileInput = document.getElementById("settingsScheduleFile");
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      await recognizeAndVerify(f, { fromSettings: true });
      fileInput.value = "";
    });
  }

  // 保存修改：基础设置按需局部更新（课表的改动在对话流的核对卡里确认保存）
  const saveBtn = document.getElementById("saveSettingsBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const basicDirty = settingsBasicDirty();
      if (!basicDirty) {
        appendAgentText("没有检测到基础设置有修改～（重新上传课表请在对话里的核对卡点「确认保存」）");
        if (window.CampusCommute) window.CampusCommute.hideSettings();
        return;
      }

      try {
        const form = readSettingsForm();
        await window.AppData.saveSettings(form);
        settingsSnapshot = form;
        // 出发地 / 通勤方式 / 学校 / 学期起点可能已变 → 更新实时计算参数，
        // 并重算所有通勤卡片（周次过滤按新学期起点重新判断）
        commuteMeta.school = form.school;
        commuteMeta.origin = form.default_departure;
        commuteMeta.mode = form.commute_mode;
        commuteMeta.semester = form.semester_start;
        syncSchoolContext();
        syncSemesterContext();
        syncCommuteCardFromSchedule({ recompute: true });
        appendAgentText("✅ 已保存基础设置！只更新了有改动的部分。");
      } catch (e) {
        console.error(e);
        appendAgentText("保存失败：" + ((e && e.message) || "请稍后再试"));
        return;
      }
      if (window.CampusCommute) window.CampusCommute.hideSettings();
    });
  }

  // 数据备份：导出 / 导入（本地 localStorage，不触碰其它功能）
  const exportBtn = document.getElementById("exportBackupBtn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      if (!window.AppData || !window.AppData.exportAll) return;
      const data = window.AppData.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = "campus-commute-backup-" + stamp + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      appendAgentText("📤 已导出备份文件「campus-commute-backup-" + stamp + ".json」，请保存到本地（如云盘 / 电脑）。换设备或用无痕模式打开前，可用「导入备份」恢复。");
    });
  }
  const importBtn = document.getElementById("importBackupBtn");
  const importFile = document.getElementById("importBackupFile");
  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const f = importFile.files && importFile.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        if (!window.confirm("导入备份将覆盖当前的课表与设置，确定继续吗？（建议先导出当前备份）")) {
          importFile.value = "";
          return;
        }
        await window.AppData.importAll(data);
        appendAgentText("📥 备份已导入，正在重新加载…");
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        console.error(e);
        appendAgentText("导入失败：文件不是有效的备份 JSON（" + ((e && e.message) || "格式错误") + "）");
      }
      importFile.value = "";
    });
  }

  // 课表预览：打开弹窗，渲染正在使用的课表（可编辑、即时落库）
  const openPreviewBtn = document.getElementById("openSchedulePreviewBtn");
  if (openPreviewBtn) openPreviewBtn.addEventListener("click", openSchedulePreview);
  const closePreviewBtn = document.getElementById("closePreviewBtn");
  if (closePreviewBtn) closePreviewBtn.addEventListener("click", closeSchedulePreview);
}

// 课表预览 / 编辑弹窗：复用核对表（renderVerifyCard）渲染正在使用的课表，
// 全局 change/click 委托已支持 data-persist="1" 即时落库，无需额外保存逻辑。
function openSchedulePreview() {
  const modal = document.getElementById("schedulePreviewModal");
  const body = document.getElementById("schedulePreviewBody");
  if (!modal || !body || !window.ScheduleCore) return;
  body.innerHTML = "";
  const cardNode = window.ScheduleCore.renderVerifyCard({
    rows: window.ScheduleCore.getRows(),
    persist: true,
    headText: "📋 当前课表（可编辑）",
    descText: "这里显示正在使用的课表。表格内可直接改课程名 / 教室 / 时间 / 周次，也能增删行；改动即时保存。",
    confirmText: "完成"
  });
  const card = cardNode.querySelector(".verify-card");
  const confirmBtn = card.querySelector(".vc-confirm");
  if (confirmBtn) confirmBtn.addEventListener("click", closeSchedulePreview);
  body.appendChild(card);
  modal.classList.add("show");
}
function closeSchedulePreview() {
  const modal = document.getElementById("schedulePreviewModal");
  if (!modal) return;
  modal.classList.remove("show");
  // 课表可能已改动 → 静默刷新通勤卡片（换卡不重复推送气泡）
  syncCommuteCardFromSchedule({ silent: true });
}

// 重置本地数据：打开自定义确认弹窗（含红色警示），不直接调原生 confirm
function openResetConfirm() {
  const modal = document.getElementById("resetConfirmModal");
  if (modal) modal.classList.add("show");
}
function closeResetConfirm() {
  const modal = document.getElementById("resetConfirmModal");
  if (modal) modal.classList.remove("show");
}

// 新用户引导上下文（学校信息保存后继续未完成的引导用）
const onboardingCtx = { fromCloud: false, session: null };

// 引导：首次 / 修改后有待核对课表 → 在对话页以对话框（气泡）形式展现核对卡；
// 无课表则引导去设置里上传（输入框旁不再有上传按钮）。
function continueOnboarding() {
  try {
    // 首次配置页保存后置位：进入对话页即展示核对卡（首次核对）
    if (localStorage.getItem("campus_show_verify")) {
      localStorage.removeItem("campus_show_verify");
      // 虽然是已保存的新课表，但要在对话里再核对一次 → 确认前不弹提醒
      if (window.AutoPush) { window.AutoPush.setConfirmed(false); window.AutoPush.clearCommuteCards(); }
      appendAgentText("我帮你认好了课表，请在这里核对一下每节课的星期、时间、教室和周次 👇");
      appendScheduleVerify();
      return;
    }
    var hasSchedule = window.ScheduleCore.getRows().length > 0;
    if (!hasSchedule) {
      appendAgentText("还没课表哦。点右上角 ⚙️「设置修改」，在里面上传课表图片，我用 AI 识别后会在这里和你核对～");
      return;
    }
    appendAgentText("你的课表已就绪。要更新课表，在 ⚙️「设置修改」里上传新课表图片即可。");
  } catch (_) {}
}

// ---- 初次使用：智能体要求先填写学校名称（精确到校区以便定位） ----
// 背景：课表里的“教三楼 302”是含糊地名，高德会定位到外省同名建筑；
// 带上「学校 + 校区」拼名查询，并把结果按学校/校区名挑选，才能定位准确。
function appendSchoolPrompt() {
  const box = document.getElementById("messageList");
  const scroll = document.getElementById("chatScroll");
  if (!box || document.getElementById("schoolNameInput")) return; // 避免重复弹出
  const t = new Date().toTimeString().slice(0, 5);
  const wrap = document.createElement("div");
  wrap.className = "msg agent";
  wrap.innerHTML = `
    <div class="avatar">🤖</div>
    <div class="bubble">
      <p>初次见面！为了把教学楼和宿舍定位准确，请先告诉我你的<b>学校名称</b>～</p>
      <div class="school-prompt">
        <div class="field">
          <label>学校名称（有校区请一起写上）</label>
          <input type="text" id="schoolNameInput" placeholder="例如：北京大学，或 北京大学昌平校区" />
        </div>
        <div class="field">
          <label>学期第一周的周一日期</label>
          <input type="date" id="semesterStartInput" />
          <div class="hint">按它计算现在第几周，判断课程这周上不上（单双周 / 起止周次）</div>
        </div>
        <button type="button" class="btn btn-primary" id="saveSchoolBtn">保存并继续</button>
      </div>
      <span class="time">${t}</span>
    </div>`;
  box.appendChild(wrap);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  const nameEl = wrap.querySelector("#schoolNameInput");
  const semEl = wrap.querySelector("#semesterStartInput");
  const btn = wrap.querySelector("#saveSchoolBtn");
  if (nameEl) nameEl.focus();

  const submit = async () => {
    const school = nameEl ? nameEl.value.trim() : "";
    if (!school) { appendAgentText("学校名称不能为空哦，填完再保存～"); if (nameEl) nameEl.focus(); return; }
    const semester = normDateStr(semEl ? semEl.value : "");
    if (btn) { btn.disabled = true; btn.textContent = "保存中…"; }
    try {
      if (window.AppData && window.AppData.saveSettings) {
        // 合并保存：只补 school / semester_start 两列，不动其它设置字段
        let cur = null;
        try { cur = await window.AppData.loadSettings(); } catch (e) {}
        await window.AppData.saveSettings(Object.assign({}, cur || {}, {
          school: school,
          semester_start: semester || null,
        }));
      }
      // 演示模式（未登录/无云端）兜底：本地记住学校信息
      try { localStorage.setItem("campus_school", JSON.stringify({ school: school })); } catch (_) {}

      commuteMeta.school = school;
      commuteMeta.semester = semester;
      syncSchoolContext();
      if (semester) syncSemesterContext(semester); // 填了才注入；没填保留既有兜底
      // 同步到设置弹窗表单，保持两处一致
      const sf = document.getElementById("set-school");
      if (sf) sf.value = school;
      const ss = document.getElementById("set-semester");
      if (ss && semester) ss.value = semester;
      const week = window.AutoPush && window.AutoPush.currentWeek ? window.AutoPush.currentWeek() : null;
      appendAgentText("好的，已记住你就读 " + school + "！之后我会用「学校 + 教学楼」向高德地图定位，通勤时间会更准。" +
        (semester
          ? "学期第 1 周从 " + semester + " 开始" + (week != null ? "，现在是第 " + week + " 周" : "") + "，我会按周次和单双周判断每门课上不上。"
          : "补一句：在设置里填上「学期第一周周一日期」，我就能按单双周和起止周次帮你判断课程啦。"));
      // 按学校前缀重新计算通勤卡片，并继续未完成的引导
      syncCommuteCardFromSchedule({ recompute: true });
      continueOnboarding();
    } catch (e) {
      console.error(e);
      appendAgentText("保存失败：" + ((e && e.message) || "请稍后再试"));
      if (btn) { btn.disabled = false; btn.textContent = "保存并继续"; }
    }
  };

  if (btn) btn.addEventListener("click", submit);
  // 输入框回车 = 点保存
  if (nameEl) nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
}

// 登录后初始化应用：加载该用户的设置与课表，渲染界面并接通云端
async function initApp(session) {
  // 1) 课表：优先云端 schedule_data；空则用示例（演示解析结果）
  let rows = [];
  let fromCloud = false;
  if (window.AppData && window.AppData.loadSchedule) {
    try {
      const cloudRows = await window.AppData.loadSchedule();
      if (cloudRows && cloudRows.length) { rows = cloudRows; fromCloud = true; }
    } catch (e) { console.error("[schedule] 读取失败", e); }
  }
  // 注意：不再回退到示例/假数据。读不到真实课表就保持空，由引导流程提示上传。
  if (window.ScheduleCore) window.ScheduleCore.setRows(rows, fromCloud ? "cloud" : "local");

  // 已存在的云端课表视为「已确认」（之前保存过）→ 直接解锁提醒；
  // 但若正处于首次核对引导（campus_show_verify），则保持待确认，等用户点确认
  var pendingVerify = !!localStorage.getItem("campus_show_verify");
  if (window.AutoPush) {
    window.AutoPush.setConfirmed(!!(rows && rows.length) && !pendingVerify);
  }

  // 2) 设置：若云端有 user_settings，回填到设置弹窗表单（弹窗在首页）
  let userSettings = null;
  if (window.AppData && window.AppData.loadSettings) {
    try {
      userSettings = await window.AppData.loadSettings();
    } catch (e) { console.error("[settings] 读取失败", e); }
  }
  if (userSettings) {
    fillSettingsForm(userSettings);
    settingsSnapshot = snapshotFromSettings(userSettings);
    // 实时通勤计算的参数来源：学校（含校区）+ 默认出发地 + 通勤方式 + 学期起点
    commuteMeta.school = userSettings.school || "";
    commuteMeta.origin = userSettings.default_departure || "";
    commuteMeta.mode = userSettings.commute_mode || "步行";
    commuteMeta.semester = normDateStr(userSettings.semester_start);
  } else {
    // 演示模式（未登录/无云端设置）：读本地记住的学校信息
    try {
      const ls = JSON.parse(localStorage.getItem("campus_school") || "null");
      if (ls && ls.school) {
        commuteMeta.school = ls.school;
      }
    } catch (_) {}
  }
  syncSchoolContext();
  if (commuteMeta.semester) syncSemesterContext(); // 云端有学期起点才注入

  // 3) 第五步：自动推送「今日后续课程」通勤卡片（按当前时间/星期筛选；
  //    学校信息已知 → 按「学校+教学楼」实时计算耗时与天气）
  syncCommuteCardFromSchedule();

  // 4) 绑定交互（首屏对话内容已由上面的自动推送生成）
  bindComposer();
  bindSettingsPanel();

  // 5) 初次使用：智能体先要求填写学校名称（精确到校区以便定位），
  //    保存后再继续后续引导（课表核对等）
  onboardingCtx.fromCloud = fromCloud;
  onboardingCtx.session = session;
  if (!commuteMeta.school) {
    appendSchoolPrompt();
    return;
  }
  continueOnboarding();
}

document.addEventListener("DOMContentLoaded", () => {
  // 落地路由：本机还没有配置数据 → 跳到首次配置页（填课表 + 默认设置）
  if (window.AppAuth && window.AppAuth.needSetup && window.AppAuth.needSetup()) {
    location.replace("setup.html");
    return;
  }
  // 已配置 → 直接进入智能体对话页
  if (window.AppAuth && window.AppAuth.requireAuth) {
    window.AppAuth.requireAuth(initApp);
  } else {
    initApp(null);
  }
});
