/**
 * 智谱 AI 代理（Cloudflare Worker，免费，无需绑卡）
 * ---------------------------------------------------------------------------
 * 作用：浏览器直连智谱会被 CORS 拦截（OPTIONS 预检无 ACAO），本 Worker 作为
 *       同源代理，由服务端持有 Key 并补充 CORS 头，前端只调本 Worker。
 *
 * 部署步骤（约 3 分钟）：
 *   1) 打开 https://workers.cloudflare.com ，用邮箱注册并登录（免费，无需信用卡）。
 *   2) 点 “Create Worker”，把本文件全部内容粘贴进去（替换默认代码）。
 *   3) 在左侧 “Settings → Variables” 里新建一个【环境变量 / Secret】：
 *        名称：ZHIPU_KEY
 *        值 ：你的智谱 Key（形如 53045c3b....guTGFOnUfqcf3z5L）
 *      保存后重新 Deploy。
 *   4) 部署完成后会得到地址，形如  https://zhipu-proxy.<你的子域>.workers.dev
 *      把该地址填到项目 assets/js/config.js 的  ZHIPU_CONFIG.proxyUrl 。
 *   5) 填好 proxyUrl 后，前端不再需要把 Key 暴露出去——可直接把 config.js 里的
 *      key 清空（浏览器不再直连智谱）。
 *
 * 说明：
 *   - ALLOWED_ORIGINS 限制了能调用本代理的来源，防止他人盗用你的 Key。
 *     若你换了发布域名或要在本地调试，请在此处增删。
 *   - Worker 会原样转发请求体（含图片 base64）到智谱，并把智谱响应透传回来。
 */

// 允许调用本代理的来源（改成你自己的发布域名 / 本地调试地址）
const ALLOWED_ORIGINS = [
  "https://campus-commute.app.workbuddy.host",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

const ZHIPU_TARGET = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    // 预检请求：直接返回 204 + CORS 头（这是修复浏览器直连失败的关键）
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 防止未授权来源盗用（如有人直接拿你的 Worker 地址刷 Key）
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders(origin) });
    }

    let body;
    try {
      body = await request.text();
    } catch (e) {
      return new Response("Bad Request", { status: 400 });
    }

    // Key 来自 Worker 环境变量（推荐，不在代码里硬编码）；
    // 若你没配环境变量，可临时把下面的 env.ZHIPU_KEY 换成字符串字面量。
    const key = (env && env.ZHIPU_KEY) || "";
    if (!key) {
      return new Response(JSON.stringify({ error: "Worker 未配置 ZHIPU_KEY 环境变量" }), {
        status: 500,
        headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(origin))
      });
    }

    // 服务端转发到智谱（这里不受浏览器 CORS 限制）
    const upstream = await fetch(ZHIPU_TARGET, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: body
    });

    const respBody = await upstream.text();
    return new Response(respBody, {
      status: upstream.status,
      headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders(origin))
    });
  }
};
