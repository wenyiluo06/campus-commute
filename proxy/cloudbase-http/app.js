'use strict';
// CloudBase HTTP 云函数（Web 函数）代理：浏览器 → 本服务(9000) → 智谱
// 仅用 Node 内置 http + 全局 fetch（Node18+），无需任何 npm 依赖。
const http = require('http');

const ZHIPU_KEY = process.env.ZHIPU_KEY || '';
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

// 允许跨域的来源（浏览器从这两个域名调用本函数）。按需增删。
const ALLOWED_ORIGINS = [
  'https://campus-commute.app.workbuddy.host',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const cors = corsHeaders(origin);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, cors));
    res.end('Method Not Allowed');
    return;
  }
  if (!ZHIPU_KEY) {
    res.writeHead(500, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    res.end(JSON.stringify({ error: '代理未配置 ZHIPU_KEY 环境变量' }));
    return;
  }

  // 读取请求体（CloudBase 函数 URL 请求体上限 1MB，前端已压缩到 1MB 内）
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 6 * 1024 * 1024) { // 二次保险
        req.destroy();
        res.writeHead(413, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
        res.end(JSON.stringify({ error: '请求体过大' }));
        return;
      }
    }
  } catch (e) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    res.end(JSON.stringify({ error: '读取请求体失败' }));
    return;
  }

  // 原样转发到智谱，仅补上 Authorization
  try {
    const upstream = await fetch(ZHIPU_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ZHIPU_KEY },
      body: body
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    res.end(text);
  } catch (e) {
    res.writeHead(502, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    res.end(JSON.stringify({ error: '代理转发智谱失败：' + (e && e.message ? e.message : String(e)) }));
  }
});

const PORT = 9000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('[zhipu-proxy] listening on 0.0.0.0:' + PORT);
});
