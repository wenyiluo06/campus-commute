/* ===================================================================
   后端配置
   - 当前版本（免登录本地版）：数据存浏览器 localStorage，无需任何后端，
     因此这里没有 Supabase / CloudBase 的配置。
   - 后续接入腾讯云 CloudBase（带登录）时，会在此新增：
       window.CLOUDBASE_CONFIG = { envId: "你的环境 ID" };
     以及替换 assets/js/local-backend.js 为 cloudbase-backend.js。
     业务层（chat.js / setup.js 等）只依赖 window.AppAuth / window.AppData，
     届时无需改动。
   =================================================================== */

/* ===================================================================
   高德地图（Web服务 Key）——通勤耗时计算
   申请位置：高德开放平台 https://lbs.amap.com → 控制台 → 应用管理 →
             创建应用 → 添加 Key → 服务平台选「Web服务」
   说明：
   - 该 Key 会暴露在前端（浏览器可直连 restapi.amap.com，已实测支持跨域）；
     生产环境建议发布后在 Key 的「安全设置」里限制，或改用自己的服务端代理。
   - 坐标请用高德坐标系（GCJ-02）；传地名时会自动调用高德地理编码转换。
   - 留空时自动进入 Mock 模式（返回模拟耗时），逻辑照样跑通。
   =================================================================== */
window.AMAP_CONFIG = {
  key: "YOUR_AMAP_KEY"   // 占位符：真实值由 config.local.js（不进 GitHub）覆盖；留空自动 Mock
};

/* ===================================================================
   和风天气 Key —— 天气 / 下雨判断
   申请与配置位置：
   1. 和风天气 https://www.qweather.com → 注册 → 完成实名认证
   2. 控制台 → 设置（https://console.qweather.com/setting）→ 查看你的 API Host
      —— 每个账号专属，形如 https://xxxxxxxx.qweatherapi.com
      （注意：不再是公共的 devapi.qweather.com，用错会返回 403 Invalid Host）
   3. 控制台 → 项目管理 → 创建应用，复制 API Key
   说明：
   - 新版和风 API：Key 走请求头 X-QW-Api-Key，路径 /weather/v1/hourly/{lat}/{lon}
   - key 留空 → 自动 Mock；key 已填但 host 未填 → 给出明确错误提示（不会静默失败）
   =================================================================== */
window.QWEATHER_CONFIG = {
  key: "YOUR_QWEATHER_KEY",    // 占位符：真实值由 config.local.js 覆盖；留空自动 Mock
  host: "YOUR_QWEATHER_HOST",  // 占位符：你的专属 API Host（控制台 → 设置）
  lang: "zh"
};

/* ===================================================================
   智谱 AI（GLM）——自然语言意图识别 + 课表图片识别（第七步）
   申请位置：智谱开放平台 https://open.bigmodel.cn → 注册 → 实名 →
             控制台 → API keys → 创建 Key（形如 xxxxxxxx.xxxxxxxx）

   ⚠️ 关于浏览器直连（重要）：
   - 智谱接口的「OPTIONS 预检」响应并不返回 CORS 头（受阿里云 WAF 影响），
     而我们的请求带 application/json + Authorization 必然触发预检，
     因此【浏览器直接 fetch 智谱会被 CORS 拦截，表现为 Failed to fetch】。
   - 已实测：POST 响应虽有 ACAO，但浏览器走的是预检，所以实战直连失败。
   - 解决办法：走一个国内可直连的代理（见 proxy/cloudbase-http/，腾讯云
     CloudBase HTTP 云函数，国内节点），由代理服务端持有 Key 并补 CORS 头。
     把代理地址填到下面的 proxyUrl 即可，前端不再直连智谱。

   配置步骤：
   1) 部署 proxy/cloudbase-http/（app.js + scf_bootstrap + package.json 打 zip）
      到腾讯云 CloudBase 云函数（运行时 Node.js 18，HTTP 云函数 / Web 函数），
      在其「环境变量」里新建 ZHIPU_KEY = 你的智谱 Key。
   2) 开启「HTTP 访问服务」，把得到的函数地址（形如
      https://<env>.ap-shanghai.app.tcloudbase.com/）填到下面的 proxyUrl。
   3) 填好后，前端不再需要把 Key 暴露出去——可直接把本文件的 key 清空。

   - model 用 glm-4-flash（免费）；visionModel 用 glm-4v-flash（免费视觉）。
   - proxyUrl 留空 → 前端会尝试直连（线上会被 CORS 拦，仅本地调试用）。
   =================================================================== */
window.ZHIPU_CONFIG = {
  key: "",                     // Key 已移至 CloudBase 代理函数的 ZHIPU_KEY 环境变量，前端不再暴露 Key（直连仅本地调试用）
  model: "glm-4-flash",        // 文本意图识别（免费）
  visionModel: "glm-4v-flash", // 课表图片识别（免费视觉模型，多模态）
  proxyUrl: "YOUR_ZHIPU_PROXY_URL"  // 占位符：真实值由 config.local.js 覆盖（CloudBase HTTP 云函数代理，国内节点）
};

/* -------------------------------------------------------------------
   本地覆盖：若同目录存在 config.local.js（已被 .gitignore 排除，不进 GitHub），
   则用它的真实值覆盖上面的占位符。
   - 线上发布时该文件随目录上传 → 真实值生效；
   - GitHub 公开仓库不含此文件 → 自动回退占位符（Mock 模式，无泄露）。
   本段必须放在本文件末尾（config.local.js 已在前面加载并设好 __LOCAL_OVERRIDES__）。
   ------------------------------------------------------------------- */
(function applyLocalOverrides() {
  var o = window.__LOCAL_OVERRIDES__;
  if (!o) return;
  if (o.amapKey) window.AMAP_CONFIG.key = o.amapKey;
  if (o.qweatherKey) window.QWEATHER_CONFIG.key = o.qweatherKey;
  if (o.qweatherHost) window.QWEATHER_CONFIG.host = o.qweatherHost;
  if (o.zhipuProxyUrl) window.ZHIPU_CONFIG.proxyUrl = o.zhipuProxyUrl;
})();
