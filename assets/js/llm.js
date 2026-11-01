/* ===================================================================
   第七步 · 智谱 AI（GLM）自然语言意图识别（纯 JS，零 UI 改动）
   ---------------------------------------------------------------------
   window.LLM.callLLM(userInput)：
     把用户输入发给智谱 GLM，强制只返回 JSON 意图，例如：
       「我马上要走了」         → {"action":"depart_now"}
       「今天不骑车了，想走路」 → {"action":"change_mode","mode":"walking"}
       「今天会下雨吗」         → {"action":"query_weather"}
       无法识别 / 闲聊          → {"action":"none"}

   设计约束：
   - System Prompt 强制「只输出 JSON、不要 Markdown 代码块」；
     响应侧仍做防御性清洗（剥掉 ```json 包裹、截取首尾花括号），
     模型偶发不守规矩时也能解析。
   - temperature=0：意图识别要确定性，不要创造性。
   - 超时 12s（AbortController）；任何失败都 throw，由调用方
     （chat.js）降级到本地正则识别，「现在出发」等核心功能不断。
   - 未配置代理也未配置 Key → isReady()=false，调用方直接走本地识别，一个请求都不发。
   - 浏览器直连智谱会被 CORS 拦截（OPTIONS 预检无 Access-Control-Allow-Origin），
     因此线上必须走 Cloudflare Worker 代理（ZHIPU_CONFIG.proxyUrl），由代理服务端
     持有 Key 并补 CORS 头；前端不再直连、也不再暴露 Key。

   关于 API Key 存放位置（已改为代理模式）：
   - 推荐：把 Key 填到 Cloudflare Worker 的环境变量 ZHIPU_KEY（见 proxy/zhipu-worker.js），
     再把代理地址填到 config.js 的 ZHIPU_CONFIG.proxyUrl。此时 config.js 的 key 留空即可。
   - 仅本地调试时可临时把 key 写在 config.js（直连），但线上会被 CORS 拦，不推荐。
   =================================================================== */
window.LLM = (function () {
  "use strict";

  var ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  var DEFAULT_MODEL = "glm-4-flash"; // 智谱免费模型，做意图识别足够快
  var VISION_MODEL = "glm-4v-flash"; // 智谱免费视觉模型，识别课表图片
    var TIMEOUT_MS = 15000;
  var VISION_TIMEOUT_MS = 90000;     // 视觉识别图片，移动网络给足时间（手机上传+智谱处理可能很慢）

  // 合法 action 白名单（防御模型幻觉）；通勤方式 code
  var ACTIONS = ["depart_now", "change_mode", "query_weather", "none"];
  var MODES = ["walking", "cycling", "transit"];

  // System Prompt：角色 + 严格的 JSON 输出规则 + action 定义
  var SYSTEM_PROMPT = [
    "你是「校园通勤提醒」应用的意图识别器。分析用户的输入，判断意图，只返回一个 JSON 对象。",
    "",
    "输出规则（必须严格遵守）：",
    "1. 只输出 JSON 对象本身：不要输出任何解释文字、不要使用 Markdown 代码块（```）包裹。",
    "2. action 为字符串，必填；所需参数无法从输入中确定时，不要臆造，按 none 处理。",
    "",
    "action 取值定义：",
    '- "depart_now"：用户表示马上出发 / 出门 / 要去上课。例如：「我马上要走了」「出门了」「现在出发」「走吧」。无参数。',
    '- "change_mode"：用户要改变通勤方式。必须带参数 mode："walking"=步行，"cycling"=骑行，"transit"=校内公交 / 坐车。例如：「今天不骑车了，我想走路」→ {"action":"change_mode","mode":"walking"}。',
    '- "query_weather"：用户询问天气 / 是否下雨 / 穿衣建议。无参数。',
    '- "none"：闲聊、无法识别、或与通勤安排无关。无参数。',
    "",
    "只返回 JSON。"
  ].join("\n");

  function cfg() {
    var c = window.ZHIPU_CONFIG || {};
    return {
      key: String(c.key || "").trim(),
      model: String(c.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      visionModel: String(c.visionModel || VISION_MODEL).trim() || VISION_MODEL,
      proxyUrl: String(c.proxyUrl || "").trim()
    };
  }

  // 是否配置了代理（推荐）或直接 Key（本地调试）
  function hasProxy() { return cfg().proxyUrl.length > 0; }

  // 是否具备调用条件：有代理或有 Key 即可
  function isReady() {
    var c = cfg();
    return c.key.length > 0 || c.proxyUrl.length > 0;
  }

  // 决定实际请求地址与是否由前端附带 Authorization：
  // - 走代理：发到 proxyUrl，代理服务端持有 Key 并补 CORS 头（前端不发送 Authorization）
  // - 直连：发到官方 ENDPOINT，前端附带 Authorization（仅本地调试，线上会被 CORS 拦）
  function endpointInfo() {
    if (hasProxy()) return { url: cfg().proxyUrl, sendAuth: false };
    return { url: ENDPOINT, sendAuth: true };
  }

  // 智谱可能在 1024 token 上限处截断 JSON：尝试补齐未闭合的括号
  function repairJson(s) {
    var t = String(s || "").replace(/,\s*$/, "");
    var ob = (t.match(/{/g) || []).length, cb = (t.match(/}/g) || []).length;
    var obr = (t.match(/\[/g) || []).length, cbr = (t.match(/\]/g) || []).length;
    while (obr > cbr) { t += "]"; cbr++; }
    while (ob > cb) { t += "}"; cb++; }
    return t;
  }

  // 把模型返回的各种“星期”写法归一为 1~7（周一=1…周日=7），解析不出返回 ""
  // 这是“显示每天”bug 的根因：模型可能返回中文「周一」而非数字 1，
  // 而核对卡下拉只认 1~7，匹配不上就静默回退到「每天」。
  function normDay(v) {
    if (v == null || v === "") return "";
    if (typeof v === "number") return (v >= 1 && v <= 7) ? String(v) : "";
    var s = String(v).trim();
    if (!s) return "";
    if (/每|全学期|整学期|全周/.test(s)) return "";  // “每天/每周/全学期”= 每天都有 → 空（UI 显示每天）
    var m = s.match(/星?期?\s*[一二三四五六日天]/);
    if (m) {
      var ch = m[0].slice(-1);
      if (ch === "天" || ch === "日") return "7";
      return String("一二三四五六".indexOf(ch) + 1);
    }
    var em = s.match(/^(mon|tue|wed|thu|fri|sat|sun)/i);
    if (em) return { mon: "1", tue: "2", wed: "3", thu: "4", fri: "5", sat: "6", sun: "7" }[em[1].toLowerCase()];
    var nm = s.match(/^[1-7]$/);
    if (nm) return nm[0];
    return "";
  }

  /* ---------------- 响应解析：防御性 JSON 提取 ---------------- */
  function extractJson(raw) {
    var s = String(raw == null ? "" : raw).trim();
    // 模型偶尔仍会包 ```json ... ```，先剥掉
    s = s.replace(/^\s*```(?:json|JSON)?\s*/i, "").replace(/\s*```\s*$/i, "");
    // 优先尝试数组（视觉识别返回 [...]，文本意图返回 {...}）
    var i = s.indexOf("["), j = s.lastIndexOf("]");
    if (i === -1 || j === -1 || j < i) {
      i = s.indexOf("{"); j = s.lastIndexOf("}");
      if (i === -1 || j === -1 || j < i) throw new Error("LLM 响应中找不到 JSON");
    }
    var sub = s.slice(i, j + 1);
    try { return JSON.parse(sub); }
    catch (e1) {
      // 先尝试补齐被截断的括号
      try { return JSON.parse(repairJson(sub)); }
      catch (e2) { throw new Error("LLM 响应不是合法 JSON"); }
    }
  }

  // 结构校验 + 归一化：结构坏了 throw（调用方降级）；action 不认识按 none
  function normalize(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new Error("LLM 响应不是 JSON 对象");
    }
    var action = String(obj.action == null ? "" : obj.action).trim();
    if (!action) throw new Error("LLM 响应缺少 action 字段");
    if (ACTIONS.indexOf(action) === -1) {
      console.warn("[llm] 未知 action，按 none 处理：", action);
      return { action: "none" };
    }
    if (action === "change_mode") {
      var mode = String(obj.mode == null ? "" : obj.mode).trim().toLowerCase();
      if (MODES.indexOf(mode) === -1) return { action: "none" }; // 缺 mode / mode 不认识
      return { action: "change_mode", mode: mode };
    }
    return { action: action };
  }

  /* ---------------- 主入口：callLLM(userInput) ----------------
     opts.context：动态上下文（当前通勤方式 / 当前时间），帮模型理解
     「不骑车了」这类相对表达；调用方（chat.js）负责传入。
     返回 Promise<{action, mode?}>；任何失败都 reject。 */
  async function callLLM(userInput, opts) {
    var c = cfg();
    if (!c.key && !c.proxyUrl) throw new Error("未配置智谱代理或 API Key（config.js → ZHIPU_CONFIG.proxyUrl / key）");

    var text = String(userInput == null ? "" : userInput).trim();
    if (!text) return { action: "none" };

    opts = opts || {};
    var ctx = opts.context || {};
    var ctxLines = [];
    if (ctx.mode) ctxLines.push("用户当前通勤方式：" + ctx.mode);
    if (ctx.nowText) ctxLines.push("当前时间：" + ctx.nowText);
    var userContent =
      (ctxLines.length ? "【当前状态】" + ctxLines.join("；") + "\n" : "") +
      "【用户输入】" + text;

    // 成本控制：每日外部 API 配额（智谱 + 高德 + 和风合并计数，超限直接拦截）
    if (window.Quota) window.Quota.guard();

    var info = endpointInfo();
    var headers = { "Content-Type": "application/json" };
    if (info.sendAuth) headers["Authorization"] = "Bearer " + c.key;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    try {
      var resp = await fetch(info.url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          model: c.model,
          temperature: 0,          // 意图识别：确定性输出
          max_tokens: 256,         // JSON 很短，256 足够
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent }
          ]
        }),
        signal: controller.signal
      });
      if (!resp.ok) {
        var errText = "";
        try { errText = await resp.text(); } catch (_) {}
        throw new Error("智谱 API HTTP " + resp.status + "：" + String(errText).slice(0, 200));
      }
      var data = null;
      try { data = await resp.json(); } catch (_) {}
      var content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : "";
      if (!content) throw new Error("智谱 API 返回内容为空");
      return normalize(extractJson(content));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- 课表图片识别：glm-4v-flash 多模态 ----------------
     把用户上传的课表图片发给智谱视觉大模型，返回结构化课表数组
     （经 ScheduleCore.normalize 归一化）。失败一律 reject，由调用方提示。 */
  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("读取图片失败")); };
      r.readAsDataURL(file);
    });
  }

  // 用 canvas 把图片压缩到最长边 maxEdge 以内、转 JPEG base64，减小请求体积
  // quality 默认 0.82；识别场景用更低质量以显著减小体积、加快上传与模型处理
  function compressImage(file, maxEdge, quality) {
    return new Promise(function (resolve, reject) {
      if (typeof Image === "undefined") { reject(new Error("no-image-api")); return; }
      quality = (quality == null) ? 0.82 : quality;
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.width || 800, h = img.height || 800;
          var scale = Math.min(1, maxEdge / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("图片解码失败（仅支持 JPG / PNG 图片）")); };
      img.src = url;
    });
  }

  // 按“体积预算”逐级压缩：先用大尺寸，超预算就逐级缩小，直到达标或最小档。
  // 手机拍的课表原图往往几 MB，缩小后能大幅缩短上传 + 智谱视觉处理时间。
  async function compressToBudget(file, edges, quality, maxBytes) {
    for (var i = 0; i < edges.length; i++) {
      try {
        var du = await compressImage(file, edges[i], quality);
        if (i === edges.length - 1 || du.length <= maxBytes) return du;
      } catch (e) { /* 该档失败，试下一档 */ }
    }
    throw new Error("图片处理失败，请用更小的图片或先截屏后上传");
  }

  var VISION_SYSTEM = [
    "你是课表识别助手。识别课表图片，只返回一个 JSON 数组，不要任何解释文字、不要 Markdown、不要多余空格与换行。",
    "每个对象用极简键：",
    '- "c"：课程名；',
    '- "d"：星期，必须是数字 1~7（周一=1，周二=2，…，周日=7）。课表是「列为星期、行为时间」的网格，每一列顶部都有星期表头（如 星期一/周一…星期日/周日，或 星期x）。【严格按列读表头】每节课必须归入它所在列正上方的那个星期表头对应的星期：该列表头是「星期一/周一」→ d=1，「星期二/周二」→ d=2，依此类推到周日 d=7。绝不要按行号、列号或默认顺序推断星期，也不要因为某列顶部或某节是空单元格就整体偏移一天。只有该课确实周一至周日每天都有时才填空字符串 ""。',
    '- "s"：开始时间 "HH:MM"；',
    '- "e"：结束时间 "HH:MM"；',
    '- "l"：地点/教室；',
    '- "w"：周次文本，如 "1-16"、"1-8"、"单周"、"双周"；无则 ""；',
    '- "t"：单双周 "odd"=单周，"even"=双周，"all"=每周；无则 ""',
    "示例：[{\"c\":\"高等数学\",\"d\":1,\"s\":\"08:00\",\"e\":\"09:40\",\"l\":\"教三201\",\"w\":\"1-16\",\"t\":\"all\"}]",
    "【紧凑·完整优先】尽量紧凑输出，务必在 1024 token 内装下全部课程；优先保证 c/d/s/e 准确；l/w/t 可写短值。",
    "若图片不清晰无法识别，返回空数组 []。"
  ].join("\n");

  /* ---------------- 带超时的 POST JSON（统一处理“被中断/网络错误”）-------------
     把 fetch 自身失败（网络断开、超时触发 AbortController、浏览器/系统中止）
     统一标记，便于调用方给出可操作提示，而不是抛出笼统的 “Aborted”。 */
  async function postJson(url, headers, bodyObj, timeoutMs) {
    var controller = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await fetch(url, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(bodyObj),
        signal: controller.signal
      });
    } catch (e) {
      var msg = (e && e.message) || "Aborted";
      var err = new Error(msg);
      err.netAbort = true;       // 是网络/中断类错误（区别于智谱返回的 4xx/5xx）
      err.timedOut = timedOut;   // 是否由我们的超时触发（true=超时；false=外部中断）
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 把图片加载到 canvas（最长边限制在 maxEdge 以内，兼顾文字可读性与上传体积）
  function loadImageToCanvas(file, maxEdge) {
    return new Promise(function (resolve, reject) {
      if (typeof Image === "undefined") { reject(new Error("no-image-api")); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.width || 800, h = img.height || 800;
          var scale = Math.min(1, maxEdge / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = cw; canvas.height = ch;
          canvas.getContext("2d").drawImage(img, 0, 0, cw, ch);
          URL.revokeObjectURL(url);
          resolve(canvas);
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("图片解码失败（仅支持 JPG / PNG 图片）")); };
      img.src = url;
    });
  }

  // 按「一天一列、最左时间列、行为时间」的周课表布局，把图【横切】成若干上下条带：
  // 每段保留完整宽度（全部 7 天列 + 时间列都在），只按“时间行”上下切，
  // 因此：① 课程单元格永不被横向切断（不会缺首/缺尾字）；
  //       ② 每段都含完整星期网格，模型按列读表头判星期更准，也不因“某列顶部为空”整体偏移一天。
  // 顶部条带自带星期表头；非顶部条带在图顶【拼回表头条】，避免跨图对齐错位（旧版“前移一天”根因）。
  // 段数按整图高度分 2~3 段：高瘦/课程多的图多切，避免单段课程过多超出视觉模型 1024 token 上限被截断。
  var HEADER_FRAC = 0.11;   // 星期表头区约占整图高度比例（不同课表可微调）
  function splitHorizontalBands(canvas, maxBytes) {
    var W = canvas.width, H = canvas.height;
    var headerH = Math.max(1, Math.round(H * HEADER_FRAC));
    if (headerH > 160) headerH = 160;        // 表头只占一行，封顶避免把数据行也带进表头条
    var headerStrip = cropRect(canvas, 0, 0, W, headerH);   // 星期表头条（拼到非顶部段顶部）
    var bands = H > 1100 ? 3 : (H > 760 ? 2 : 1);
    var overlap = Math.round(H * 0.06);      // 段间纵向重叠，避免某节课被切断
    var composed = [];
    for (var i = 0; i < bands; i++) {
      var y0 = Math.max(0, Math.round(i * (H - overlap) / bands));
      var y1 = Math.min(H, Math.round((i + 1) * (H - overlap) / bands) + (i < bands - 1 ? overlap : 0));
      var rowsH = y1 - y0;
      if (rowsH <= 0) continue;
      var rowsBand = cropRect(canvas, 0, y0, W, rowsH);
      var finalCanvas;
      if (i === 0) {
        finalCanvas = rowsBand;              // 顶部段自带表头
      } else {
        finalCanvas = document.createElement("canvas");
        finalCanvas.width = W;
        finalCanvas.height = headerH + rowsH;
        var ctx = finalCanvas.getContext("2d");
        ctx.drawImage(headerStrip, 0, 0);
        ctx.drawImage(rowsBand, 0, headerH);
      }
      composed.push(bandToDataUrl(finalCanvas, maxBytes));
    }
    return composed;
  }
  // 从原图裁出矩形区域 [x, x+w) × [y, y+h) 的 canvas
  function cropRect(canvas, x, y, w, h) {
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    c.getContext("2d").drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }
  // 课名是否“同一门课的截断副本”：去掉空格后相等、或一方是另一方子串（覆盖缺首/缺尾字）
  function normName(s) { return (s || "").replace(/\s+/g, "").trim(); }
  function nameSimilar(a, b) {
    var x = normName(a), y = normName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.length >= 2 && y.length >= 2 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0)) return true;
    return false;
  }
  function bandToDataUrl(canvas, maxBytes) {
    var q = 0.82;
    var du = canvas.toDataURL("image/jpeg", q);
    while (du.length > maxBytes && q > 0.3) { q -= 0.15; du = canvas.toDataURL("image/jpeg", q); }
    return du;
  }

  // 从对象里按候选键顺序取第一个非空值
  function pick(r, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (r[keys[i]] != null && String(r[keys[i]]).trim() !== "") return String(r[keys[i]]).trim();
    }
    return "";
  }

  // 单段图片 → 视觉识别 → 返回原始课程对象数组（不展开）
  // extraHint：针对该段的补充提示（如“读紧挨时间轴右边的那一列”）。
  async function visionOnce(dataUrl, info, headers, c, extraHint) {
    var imgs = [{ type: "image_url", image_url: { url: dataUrl } }];
    var hint = (extraHint || "请识别这张课表图片，按系统指令返回 JSON 数组。") +
               "这张图是一张完整课表：最左侧是「节次/时间」列，顶部是「星期」表头，每一列代表一天（星期一列在最左、星期日列在最右）。" +
               "请逐列逐行读取全部课程：某列顶部表头是「星期一/周一」→ 该列课程 d=1，星期二→d=2，…，周日→d=7。" +
               "每门课填 d = 它所在列顶部表头对应的星期数字；只有该课确实每天都有时才填空字符串 \"\"。不要按行号或默认顺序推断星期。";
    var resp = await postJson(info.url, headers, {
      model: c.visionModel,
      temperature: 0,
      max_tokens: 1024,   // 智谱视觉模型 glm-4v-flash 硬性上限 [1,1024]
      messages: [
        { role: "system", content: VISION_SYSTEM },
        {
          role: "user",
          content: imgs.length ? [{ type: "text", text: hint }].concat(imgs) : [{ type: "text", text: hint }]
        }
      ]
    }, VISION_TIMEOUT_MS);
    if (!resp.ok) {
      var errText = "";
      try { errText = await resp.text(); } catch (_) {}
      throw new Error("智谱视觉接口 HTTP " + resp.status + "：" + String(errText).slice(0, 200));
    }
    var raw = "";
    try { raw = await resp.text(); } catch (_) {}
    var data = null;
    try { data = JSON.parse(raw); } catch (_) {}
    if (data && data.error) {
      throw new Error("智谱返回错误：" + ((data.error && data.error.message) || JSON.stringify(data.error)));
    }
    var content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : "";
    if (!content) {
      throw new Error("智谱视觉接口返回内容为空（原始响应前 200 字：" + String(raw).slice(0, 200) + "）");
    }
    var parsed;
    try { parsed = extractJson(content); }
    catch (e) {
      throw new Error("课表 JSON 解析失败（智谱返回内容可能超长被截断或不合规）。原始返回前 400 字：" + content.slice(0, 400));
    }
    var arr = Array.isArray(parsed) ? parsed
      : (parsed && Array.isArray(parsed.courses) ? parsed.courses
        : (parsed && Array.isArray(parsed.data) ? parsed.data : []));
    return arr || [];
  }

  async function recognizeSchedule(file) {
    var c = cfg();
    if (!c.key && !c.proxyUrl) throw new Error("未配置智谱代理或 API Key（config.js → ZHIPU_CONFIG.proxyUrl / key）");
    if (!file) throw new Error("未选择课表图片");

    // 成本控制：图片识别也算一次外部 API 调用，计入每日配额（分段识别也只算 1 次）
    if (window.Quota) window.Quota.guard();

    // 加载并限制尺寸；按「一天一列、最左为时间列」布局【横切】成 2~3 段（每段保留完整宽度网格），
    // 课程单元格不被横向切断（解决缺字/周一丢失），每段都含星期表头、模型按列读表头判星期。
    var base;
    try { base = await loadImageToCanvas(file, 1100); }
    catch (e) { throw new Error("图片处理失败，请用更小的图片或先截屏后上传"); }
    var bands = splitHorizontalBands(base, 0.9 * 1024 * 1024);

    var info = endpointInfo();
    var headers = { "Content-Type": "application/json" };
    if (info.sendAuth) headers["Authorization"] = "Bearer " + c.key;

    // 并行识别各段（每段都很小，整体耗时≈单次）；单段失败不阻断，其余段照常。
    var segResults = await Promise.all(bands.map(function (b, idx) {
      var extra = (idx === 0)
        ? "（这是包含表头的顶部段，请识别本段全部课程。）"
        : "（这是下半部分，图顶部已为你附上星期表头，请按附带的表头判断每节课星期，识别本段全部课程。）";
      return visionOnce(b, info, headers, c, extra).then(function (p) { return p; },
        function (e) { return null; });   // 单段异常 → 该段返回 null，不拖垮整体
    }));

    var allRaw = [];
    var segCounts = [];   // 各段识别到的课程数（诊断用）
    var segFail = 0;
    for (var b = 0; b < segResults.length; b++) {
      var part = segResults[b];
      if (part == null) { segFail++; segCounts.push(-1); continue; }
      segCounts.push(part.length);
      for (var k = 0; k < part.length; k++) allRaw.push(part[k]);
    }
    if (allRaw.length === 0) {
      if (segFail === bands.length) {
        throw new Error("所有分段识别都失败了（可能是网络/代理问题）。请检查 CloudBase 代理可达性，或稍后重试。");
      }
      throw new Error("未能从图片中识别出课程（部分分段失败，可能图片不清晰或课表区域外有大量空白）");
    }

    // 段间纵向重叠产生的重复：同 星期+时间 且课名相似的保留更完整的一份
    // （如某课在相邻段被切成「高等」/「等数学」→ 保留更完整、并采用其正确星期）。
    // 必须同时比对 d（星期），否则会把“不同天、同一时间、同名”的课（很常见）误并掉。
    var raw2 = [];
    for (var ri = 0; ri < allRaw.length; ri++) {
      var a = allRaw[ri];
      var na = pick(a, ["c", "course_name", "name"]);
      var ta = pick(a, ["s", "start_time", "start"]);
      var da = normDay(pick(a, ["d", "day", "weekday"]));
      var merged = false;
      for (var rj = 0; rj < raw2.length; rj++) {
        var b = raw2[rj];
        var nb = pick(b, ["c", "course_name", "name"]);
        var tb = pick(b, ["s", "start_time", "start"]);
        var db = normDay(pick(b, ["d", "day", "weekday"]));
        if (da === db && (!ta || !tb || ta === tb) && nameSimilar(na, nb)) {
          if ((na || "").length > (nb || "").length) raw2[rj] = a; // 保留课名更完整的
          merged = true; break;
        }
      }
      if (!merged) raw2.push(a);
    }
    allRaw = raw2;

    // 展开极简键(c/d/s/e/l/w/t)与完整键，归一 day/week_type；按 (课名+时间+星期+地点) 去重，重排 idx
    var seen = {};
    var expanded = [];
    for (var i = 0; i < allRaw.length; i++) {
      var r = allRaw[i];
      var row = {
        course_name: pick(r, ["c", "course_name", "name"]),
        start_time: pick(r, ["s", "start_time", "start"]),
        end_time: pick(r, ["e", "end_time", "end"]),
        location: pick(r, ["l", "location", "room"]),
        weeks: pick(r, ["w", "weeks"]),
        day: normDay(pick(r, ["d", "day", "weekday"])),
        week_type: pick(r, ["t", "week_type"])
      };
      var key = [row.course_name, row.start_time, row.day, row.location].join("|").trim();
      if (!key || seen[key]) continue;   // 空行或分段重叠重复 → 跳过
      seen[key] = true;
      expanded.push(row);
    }
    if (!expanded.length) throw new Error("未能从图片中识别出课程");
    // 诊断：各段识别数 + 最终星期分布（便于定位“某天课程缺失”，在浏览器 console 查看）
    try {
      var dayDist = {};
      expanded.forEach(function (r) { var d = r.day || "?"; dayDist[d] = (dayDist[d] || 0) + 1; });
      console.log("[课表识别] 段数=" + bands.length + " 失败段=" + segFail +
                  " 各段课程数=" + JSON.stringify(segCounts) +
                  " 合并后=" + expanded.length + " 星期分布=" + JSON.stringify(dayDist));
    } catch (e) {}
    return window.ScheduleCore.normalize(expanded);
  }

  return {
    callLLM: callLLM,
    recognizeSchedule: recognizeSchedule,
    fileToDataUrl: fileToDataUrl,
    compressImage: compressImage,
    isReady: isReady,
    hasProxy: hasProxy,
    extractJson: extractJson,   // 导出供测试
    normalize: normalize,       // 导出供测试
    normDay: normDay,           // 导出供测试
    nameSimilar: nameSimilar,   // 导出供测试（模糊去重）
    ENDPOINT: ENDPOINT,
    DEFAULT_MODEL: DEFAULT_MODEL,
    SYSTEM_PROMPT: SYSTEM_PROMPT
  };
})();
