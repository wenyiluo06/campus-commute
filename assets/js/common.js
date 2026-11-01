/* ===================================================================
   通用脚本：顶栏“添加到桌面”提示 + 安装逻辑 + 设置弹窗控制
   =================================================================== */

// 当前页面是否在“首次配置”流程之外（聊天首页）才有顶栏按钮
(function () {
  "use strict";

  // ---- 把代理/识别相关的常见错误翻译成用户可操作的提示 ----
  // 在聊天页与设置/首页上传失败处共用，避免笼统的“Failed to fetch”
  window.diagnoseProxyError = function (raw) {
    raw = String(raw || "");
    // 已经是代码内部写好的精准诊断（含 CloudBase 函数超时指引），原样返回，避免被下方通用分支覆盖
    if (/CloudBase|执行超时|服务端强制中止|超时时间/i.test(raw)) return raw;
    if (/未配置 ZHIPU_KEY/i.test(raw)) {
      return "代理（Cloudflare Worker）里还没设置智谱 Key。请到 Cloudflare Workers 控制台 → 你的 zhipu-proxy → Settings → Variables，新建环境变量 ZHIPU_KEY = 你的智谱 Key，保存后重新 Deploy。";
    }
    if (/HTTP 40\d|HTTP 50\d/i.test(raw)) {
      if (/401/.test(raw)) return raw + "（代理已响应：智谱返回 401，说明 ZHIPU_KEY 填错或失效，请检查后重新 Deploy）。";
      if (/403/.test(raw)) return raw + "（代理返回 403：当前网页域名不在 Worker 的 ALLOWED_ORIGINS 里，请核对发布域名）。";
      if (/429/.test(raw)) return raw + "（智谱返回 429：今日额度已用尽，明天再试）。";
      return raw + "（代理已响应但智谱侧报错）。";
    }
    if (/超时|timed out|超过 \d+ 秒|timeout/i.test(raw)) {
      return "识别超时：手机网络较慢或图片较大。请① 在网络良好的环境（Wi-Fi 或信号强处）重试；② 先截屏只保留课表区域、缩小图片后再上传（图片越小越快）；③ 保持本页面在前台、屏幕常亮。";
    }
    if (/Aborted|中断|abort|aborted/i.test(raw)) {
      return "识别请求被中断：多半是页面切到后台或屏幕熄灭导致浏览器中止了上传。请保持本页面在前台、屏幕常亮，不要切到其它 App，再试一次。";
    }
    if (/Failed to fetch|NetworkError|network|TypeError|Load failed/i.test(raw)) {
      return "代理地址访问不通（浏览器拦截 / 网络错误）。最常见是：① Worker 仍是默认的 Hello World，没有把 proxy/zhipu-worker.js 代码粘贴进去并 Deploy；② config.js 的 proxyUrl 与你的 Worker 地址不一致；③ Worker 没部署成功。请确认这三点后重试。";
    }
    return raw || "请换一张清晰、正向的课表图片重试";
  };

  // ---- 添加到桌面：捕获浏览器原生安装事件 ----
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById("addDesktopBtn");
    if (btn) btn.classList.add("available");
  });

  const addBtn = document.getElementById("addDesktopBtn");
  const popover = document.getElementById("addDesktopPopover");

  if (addBtn) {
    addBtn.addEventListener("click", async () => {
      if (deferredPrompt) {
        // 浏览器支持原生安装：直接唤起安装
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        addBtn.classList.remove("available");
      } else if (popover) {
        // 不支持原生安装（如 iOS Safari）：展示手动添加指引
        popover.classList.toggle("show");
      }
    });
  }

  // 关闭提示气泡
  document.querySelectorAll("[data-close-popover]").forEach((el) => {
    el.addEventListener("click", () => {
      const p = document.getElementById("addDesktopPopover");
      if (p) p.classList.remove("show");
    });
  });
  document.addEventListener("click", (e) => {
    if (popover && !popover.contains(e.target) && e.target !== addBtn) {
      popover.classList.remove("show");
    }
  });

  // ---- 设置弹窗：打开 / 关闭 ----
  const settingsModal = document.getElementById("settingsModal");
  const openSettings = document.getElementById("openSettingsBtn");
  const closeSettings = document.getElementById("closeSettingsBtn");
  const cancelSettings = document.getElementById("cancelSettingsBtn");

  function showModal() { if (settingsModal) settingsModal.classList.add("show"); }
  function hideModal() { if (settingsModal) settingsModal.classList.remove("show"); }

  if (openSettings) openSettings.addEventListener("click", showModal);
  if (closeSettings) closeSettings.addEventListener("click", hideModal);
  if (cancelSettings) cancelSettings.addEventListener("click", hideModal);
  if (settingsModal) {
    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal) hideModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideModal();
  });

  // ---- 通用：课表图片上传（点击 / 拖拽占位） ----
  function bindUploadZone(zoneId, inputId, nameId) {
    const zone = document.getElementById(zoneId);
    const fileInput = document.getElementById(inputId);
    const fileName = document.getElementById(nameId);
    if (!zone || !fileInput) return;

    zone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) {
        fileName.textContent = "已选择：" + fileInput.files[0].name;
      }
    });
    ["dragover", "dragenter"].forEach((ev) =>
      zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("drag"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("drag"); })
    );
    zone.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files[0];
      if (f) {
        fileName.textContent = "已选择：" + f.name;
        try { fileInput.files = e.dataTransfer.files; } catch (_) {}
      }
    });
  }

  // 设置弹窗内的“课表更改”图片上传
  bindUploadZone("settingsUploadZone", "settingsScheduleFile", "settingsUploadFileName");

  // 暴露给页面脚本使用
  window.bindUploadZone = bindUploadZone;
  window.CampusCommute = { showSettings: showModal, hideSettings: hideModal };

  // ---- 课表数据：localStorage 持久化 ----
  // 注意：以下示例数组已不再作为“演示兜底”使用（chat.js 不再回退到假数据）。
  // 仅保留作参考；真实课表来自用户上传 + 智谱视觉识别。
  const campusSampleSchedule = [
    { idx: 1, name: "高等数学（必修）", start: "10:00", end: "11:40", room: "教三楼 302",  weeks: "1-16",     start_week: 1,  end_week: 16, week_type: "all" },
    { idx: 2, name: "大学英语",       start: "14:00", end: "15:40", room: "外语楼 105",   weeks: "1-16 单周", start_week: 1,  end_week: 16, week_type: "odd" },
    { idx: 3, name: "程序设计基础",   start: "16:00", end: "17:40", room: "计算机楼 401", weeks: "2-15",     start_week: 2,  end_week: 15, week_type: "all" },
    { idx: 4, name: "线性代数",       start: "19:00", end: "20:40", room: "教二楼 208",   weeks: "1-16",     start_week: 1,  end_week: 16, week_type: "all" },
    { idx: 5, name: "体育（篮球）",   start: "08:00", end: "09:40", room: "体育馆 B 区",  weeks: "1-8",      start_week: 1,  end_week: 8,  week_type: "all" },
  ];

  function getSchedule() {
    try {
      const raw = localStorage.getItem("campus_schedule");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch (_) {}
    // 不再回退到示例/假数据：无真实课表就返回空，由引导流程提示上传
    return [];
  }

  function saveSchedule(data) {
    try { localStorage.setItem("campus_schedule", JSON.stringify(data)); } catch (_) {}
  }

  window.campusSampleSchedule = campusSampleSchedule;
  window.getSchedule = getSchedule;
  window.saveSchedule = saveSchedule;
})();
