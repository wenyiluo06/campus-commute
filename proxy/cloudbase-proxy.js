/* ===================================================================
   智谱 AI 代理 · 腾讯云 CloudBase 云函数版（国内节点）
   -------------------------------------------------------------------
   为什么换它：Cloudflare 免费版没有中国大陆节点，*.workers.dev 在国内的
   长连接常被掐断，导致课表识别卡到超时（图片再小也没用）。CloudBase 云函数
   部署在腾讯云国内节点，浏览器 → CloudBase（国内）→ 智谱（国内）全程国内，
   稳定且快。

   部署步骤（约 5 分钟）：
   1) 登录 https://console.cloud.tencent.com/tcb （腾讯云云开发），
      新建/选择一个环境（个人免费体验版即可，无需按量付费）。
   2) 左侧「云函数」→「新建云函数」：
      - 函数名称：zhipu-proxy
      - 运行环境：Node.js 18（必须 ≥18，因为用了全局 fetch）
      - 在「函数代码」把本文件内容粘贴为 index.js（覆盖默认代码）
      - 「环境变量」新增一项：ZHIPU_KEY = 你的智谱 Key
        （形如 53045c3b....guTGFOnUfqcf3z5L，不要带引号）
      - 保存
   3) 开启「HTTP 访问服务 / 函数 URL 化」：
      - 在函数详情里找到「HTTP 访问服务」或「函数 URL」，开启并创建访问路径
        （如 /zhipu-proxy），得到形如
        https://<env>.service.tcloudbase.com/zhipu-proxy 的地址。
      - 把该地址发给助手填进 config.js 的 ZHIPU_CONFIG.proxyUrl 并重新发布；
        或你自己改 config.js 后让助手重新发布。
   4) 回到网站重新上传课表即可（CORS 由本函数自己补，控制台无需再开 CORS）。

   说明：
   - 本函数只做“转发 + 补 CORS 头”，Key 在服务端环境变量里，前端不暴露。
   - 请求体超过 1MB（CloudBase 硬上限）会被拒，前端已把图片压到 1MB 以内。
   - 若浏览器仍报 CORS，可在 CloudBase 控制台的 CORS 设置里允许来源
     https://campus-commute.app.workbuddy.host （本函数也会回显，通常无需）。
   =================================================================== */

const ZHIPU_TARGET = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

// 允许调用的来源（防止他人盗用你的 Key）。换成你自己的发布域名即可。
const ALLOWED_ORIGINS = [
  "https://campus-commute.app.workbuddy.host",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

exports.main = async (event, context) => {
  const method = String((event && event.httpMethod) || "GET").toUpperCase();
  const headers = (event && event.headers) || {};
  const origin = headers.Origin || headers.origin || ALLOWED_ORIGINS[0];

  const cors = corsHeaders(origin);

  // 预检请求：返回 204 + CORS 头（修复浏览器跨域的关键）
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (method !== "POST") {
    return { statusCode: 405, headers: cors, body: "Method Not Allowed" };
  }

  // 读取请求体（CloudBase 可能以 base64 传 body）
  let body = event.body;
  if (event.isBase64Encoded && typeof body === "string") {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  if (body && typeof body === "object") body = JSON.stringify(body);

  const key = (process.env.ZHIPU_KEY) || "";
  if (!key) {
    return {
      statusCode: 500,
      headers: Object.assign({ "Content-Type": "application/json" }, cors),
      body: JSON.stringify({ error: "云函数未配置 ZHIPU_KEY 环境变量" })
    };
  }

  try {
    // 服务端转发到智谱（不受浏览器 CORS 限制）
    const upstream = await fetch(ZHIPU_TARGET, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: body
    });
    const respBody = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, cors),
      body: respBody
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: Object.assign({ "Content-Type": "application/json" }, cors),
      body: JSON.stringify({ error: "代理转发失败：" + (e && e.message ? e.message : String(e)) })
    };
  }
};
