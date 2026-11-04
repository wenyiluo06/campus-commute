/* ===================================================================
   外部 API 接入层：高德地图（通勤耗时）+ 和风天气（下雨判断）

   Key 配置（assets/js/config.js）：
     window.AMAP_CONFIG     = { key: "你的高德 Web服务 Key" }
     window.QWEATHER_CONFIG = { key: "和风 API Key", host: "你的专属 API Host" }

   和风天气新版体系（2025+，每个账号专属 Host）：
     - host：控制台 → 设置 查看，形如 https://xxxxxxxx.qweatherapi.com
      （公共 host devapi/api.qweather.com 已不认新 Key，返回 403 Invalid Host）
     - 认证：请求头 X-QW-Api-Key（不再是 ?key= 查询参数）
     - 路径：GET {host}/weather/v1/hourly/{纬度}/{经度}?hours=N&lang=zh
     - 旧体系（v7，?key= + /v7/weather/24h）作为回退保留：host 含
       devapi/api.qweather.com 时自动走旧路径

   特性：
   - Key 留空 → 对应 API 自动进入 Mock 模式（返回稳定的模拟数据），
     无 Key 也能跑通全部逻辑；填入 Key 后自动切真实 API，无需改代码。
   - restapi.amap.com 已实测返回 Access-Control-Allow-Origin: *，浏览器可直连。
   - 高德坐标请用 GCJ-02（高德坐标系）；传地名会自动地理编码转换。

   对外接口（window.CommuteAPI）：
     getCommuteTime(origin, destination, mode)      → Promise<number> 分钟
     getCommuteDetail(origin, destination, mode)    → Promise<{minutes, distanceText, ...}>
     checkWeather(location, opts)                   → Promise<{raining, text, ...}>
     getCommuteSummary(origin, destination, mode, location) → Promise<两者合并>
     setSchoolContext(school, campus?)            → 设置学校上下文（地理编码拼名用；学校为一个字段，含校区）
     status()                                       → 各 API 当前模式（mock / ready）

   学校上下文（setSchoolContext）：
     课表里的“教三楼 302”、设置里的“梅园 3 栋”都是含糊地名，高德会定位到
     外省同名建筑（实测“北京大学梅园3栋518”前 5 个候选是大兴/通州梅园）。
     设置学校后，地理编码按「无空格连写 → 带空格 → 裸地名」三级查询
     （实测：带空格的“北京大学 第二教学楼”会把苏州同名建筑排第一，无空格
     连写则直接命中），并按学校/校区名从候选里挑选；楼名在校内不存在时
     回退到该校区中心点，不会定位到外省。
     学校是单个字段：填「北京大学」或「北京大学昌平校区」均可，校区信息
     自动参与候选挑选。
   =================================================================== */
window.CommuteAPI = (function () {
  "use strict";

  var AMAP_BASE = "https://restapi.amap.com/v3";

  function amapKey() { return (window.AMAP_CONFIG && window.AMAP_CONFIG.key) || ""; }
  function qwKey() { return (window.QWEATHER_CONFIG && window.QWEATHER_CONFIG.key) || ""; }
  function amapMock() { return !amapKey(); }
  function qwMock() { return !qwKey(); }

  // 和风新版：账号专属 Host（控制台 → 设置 查看），形如 https://xxx.qweatherapi.com
  function qwHost() {
    var h = (window.QWEATHER_CONFIG && window.QWEATHER_CONFIG.host) || "";
    return h.replace(/\/+$/, "");
  }
  function isNewQWeather() { return qwHost().indexOf("qweatherapi.com") > -1; }
  // 降水类型是否算"下雨"（雨/雪/冰粒/混合降水）
  function isWetType(type) {
    return type === "rain" || type === "snow" || type === "ice" || type === "mixed";
  }

  // ---- 工具 ----
  // 稳定散列：让 Mock 结果对同一输入保持不变（刷新页面结果不变）
  function hash(str) {
    var h = 0;
    var s = String(str || "");
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  function looksLikeCoords(s) {
    return /^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/.test(String(s || "").trim());
  }

  // 模式归一化：walk / bike / drive（兼容 walking / 骑车 / 开车 等写法；
  // 「校内公交」按驾车路线估算——高德无校内小公交专用路径规划）
  var MODE_LABEL = { walk: "步行", bike: "骑行", drive: "驾车" };
  var MODE_ENDPOINT = { walk: "walking", bike: "bicycling", drive: "driving" };
  function normalizeMode(mode) {
    var m = String(mode || "").toLowerCase();
    if (m === "bike" || m === "riding" || m === "bicycling" || m === "骑车" || m === "骑行") return "bike";
    if (m === "drive" || m === "driving" || m === "car" || m === "驾车" || m === "开车" ||
        m.indexOf("公交") > -1 || m.indexOf("bus") > -1) return "drive";
    return "walk"; // walk / walking / 走路 / 步行 及其它默认值
  }

  // 从 direction 响应里取 duration(秒) / distance(米)；
  // 注意：bicycling 的响应外壳是 { errcode, data:{ paths:[...] } }，
  //       与 walking / driving 的 { status, route:{ paths:[...] } } 不同。
  function parseDirection(j, mode) {
    var path = null;
    if (mode === "bike") {
      if (!j || String(j.errcode) !== "0" || !j.data || !j.data.paths || !j.data.paths.length) return null;
      path = j.data.paths[0];
    } else {
      if (!j || j.status !== "1" || !j.route || !j.route.paths || !j.route.paths.length) return null;
      path = j.route.paths[0];
    }
    var dur = parseInt(path.duration, 10) || 0;
    var dist = parseFloat(path.distance) || 0;
    // driving 个别版本把时长/距离放在 steps 里，做一次兜底求和
    if ((!dur || !dist) && path.steps && path.steps.length) {
      var sumD = 0, sumT = 0;
      for (var i = 0; i < path.steps.length; i++) {
        sumD += parseFloat(path.steps[i].distance) || 0;
        sumT += parseInt(path.steps[i].duration, 10) || 0;
      }
      if (!dist) dist = sumD;
      if (!dur) dur = sumT;
    }
    return { duration: dur, distance: dist };
  }

  // ---- 学校上下文：让「教学楼 / 宿舍」这类含糊地名定位到正确校区 ----
  // 背景：高德对“梅园 3 栋”这类宿舍名会返回全国同名地点（实测
  // “北京大学梅园3栋518”前 5 个候选是大兴/通州梅园，第 6 个才是北大本部）。
  // 因此必须三管齐下：
  // ① 查询词拼上学校，且「无空格连写」优先——实测带空格的
  //    “北京大学 第二教学楼”会被高德当成独立 POI“第二教学楼”匹配，
  //    苏州同名建筑排第一；而无空格连写直接命中正确 POI；
  // ② 按学校/校区名从候选结果里挑最匹配的；
  // ③ 楼名在校内不存在时，高德会模糊回退到学校/校区中心点（可接受）。
  //
  // 学校是【一个字段】：用户填「北京大学」或「北京大学昌平校区」。
  // 校区（campus）用于候选挑选——调用方可显式传入，否则自动从学校名
  // 末尾的「XX校区」提取（提取不准也没关系，pickBestGeocode 会用
  // 从长到短的多个匹配键逐个试）。
  var SCHOOL_CTX = { school: "", campus: "" };
  var geocodeCache = {}; // 同一查询本次会话只编码一次（省高德配额）

  function setSchoolContext(school, campus) {
    SCHOOL_CTX.school = String(school || "").trim();
    SCHOOL_CTX.campus = String(campus || "").trim();
    geocodeCache = {}; // 学校信息变化 → 旧坐标缓存作废
  }

  // 生成高德地理编码查询词候选（按优先级，逐个尝试，命中即止）：
  // ① 无空格连写「学校+地点」——高德对中文连写命中率最高
  //    （内部空白也去掉：“梅园 3 栋 518”→“北京大学梅园3栋518”）
  // ② 带空格版本「学校 地点」——连写查不到时的补充
  // ③ 裸地名——学校上下文完全用不上时保底
  // 已含学校名的输入不重复拼；所有候选都会经过 pickBestGeocode 挑选。
  function composeQueries(place) {
    var p = String(place || "").trim();
    var school = SCHOOL_CTX.school;
    if (!school || !p || p.indexOf(school) > -1) return [p];
    var joined = (school + p).replace(/\s+/g, "");
    var spaced = (school + " " + p).trim();
    var list = [joined];
    if (spaced !== joined) list.push(spaced);
    if (p !== joined && p !== spaced) list.push(p);
    return list;
  }

  // 候选匹配键（按优先级）：显式校区 > 学校名末尾「XX校区」从长到短的窗口
  // > 完整学校名。例：school="北京大学昌平校区" →
  // ["学昌平校区","昌平校区","平校区","校区","北京大学昌平校区"]，
  // 这样无论是“北京大学昌平校区(公交站)”还是“北京大学(昌平校区)”
  // 形式的候选都能命中。
  function schoolMatchKeys() {
    var school = SCHOOL_CTX.school, campus = SCHOOL_CTX.campus;
    var keys = [];
    if (campus) keys.push(campus);
    if (school) {
      var i = school.lastIndexOf("校区");
      if (i > 0) {
        for (var k = Math.min(4, i); k >= 1; k--) {
          keys.push(school.substring(i - k + 1, i + 2));
        }
      }
      keys.push(school);
    }
    return keys;
  }

  // 从地理编码候选里挑最匹配学校/校区的（按匹配键逐个试，命中即止）
  function pickBestGeocode(geocodes) {
    if (!geocodes || !geocodes.length) return null;
    var keys = schoolMatchKeys();
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      if (!key) continue;
      for (var i = 0; i < geocodes.length; i++) {
        var addr = String((geocodes[i] && geocodes[i].formatted_address) || "");
        if (addr.indexOf(key) > -1) return geocodes[i];
      }
    }
    return geocodes[0];
  }

  // ---- 高德：地址 → 坐标（GCJ-02）；已是坐标则原样返回 ----
  async function geocodeOnce(query) {
    // 成本控制：地理编码也是高德真实调用，必须纳入每日外部 API 配额，
    // 否则可绕过前端 20 次/天限制去刷高德（geocode 在 getCommuteDetail 的 guard 之前发生）
    if (window.Quota) window.Quota.guard();
    var url = AMAP_BASE + "/geocode/geo?address=" + encodeURIComponent(query) +
              "&key=" + encodeURIComponent(amapKey());
    var res = await fetch(url);
    var j = await res.json();
    if (j.status !== "1" || !j.geocodes || !j.geocodes.length) {
      return { ok: false, info: j.info || "未找到该地址" };
    }
    return { ok: true, geo: pickBestGeocode(j.geocodes) };
  }

  async function toCoords(place) {
    var s = String(place || "").trim();
    if (!s) throw new Error("地点不能为空");
    if (looksLikeCoords(s)) return s.replace(/\s+/g, "");

    if (amapMock()) {
      // Mock：用散列生成一组稳定的北京城区坐标（仅演示）
      var h = hash(s);
      var lon = (116.30 + (h % 100) / 100).toFixed(6);
      var lat = (39.85 + (h % 80) / 100).toFixed(6);
      return lon + "," + lat;
    }

    var queries = composeQueries(s);
    // 缓存命中（本次会话同一查询只编码一次，省高德配额）
    for (var i = 0; i < queries.length; i++) {
      if (geocodeCache[queries[i]]) return geocodeCache[queries[i]];
    }
    // 连写 → 带空格 → 裸地名，逐级尝试；每个候选都过 pickBestGeocode 挑选
    var lastInfo = "";
    for (var j = 0; j < queries.length; j++) {
      var q = queries[j];
      var r = await geocodeOnce(q);
      if (r.ok) {
        geocodeCache[q] = r.geo.location;
        return r.geo.location;
      }
      lastInfo = r.info;
    }
    throw new Error("地理编码失败：" + (lastInfo || "未找到该地址") + "（" + queries[0] + "）");
  }

  // ---- Mock：通勤耗时（按交通方式给一个稳定区间） ----
  function mockCommute(from, to, mode) {
    var seed = hash(from + "|" + to + "|" + mode);
    var speedKmh = mode === "walk" ? 5 : mode === "bike" ? 15 : 28; // km/h
    var baseMin = mode === "walk" ? 12 : mode === "bike" ? 6 : 8;
    var minutes = baseMin + (seed % 9); // 稳定抖动 0~8 分钟
    var km = speedKmh * (minutes / 60);
    return {
      minutes: minutes,
      seconds: minutes * 60,
      distance: km * 1000,
      distanceText: km.toFixed(1) + " 公里",
      mode: mode,
      modeLabel: MODE_LABEL[mode],
      source: "mock"
    };
  }

  /**
   * 通勤耗时详情
   * @param origin       出发地：坐标 "lon,lat"（GCJ-02）或地址名
   * @param destination  目的地：同上
   * @param mode         交通方式：walk / bike / drive（兼容中文）
   * @returns Promise<{ minutes, seconds, distance, distanceText, mode, modeLabel, source }>
   */
  async function getCommuteDetail(origin, destination, mode) {
    var m = normalizeMode(mode);
    var from = await toCoords(origin);
    var to = await toCoords(destination);

    if (amapMock()) {
      var d = mockCommute(from, to, m);
      console.log("[CommuteAPI][Mock] 通勤估算：", origin, "→", destination, d);
      return d;
    }

    // 成本控制：每日外部 API 配额（仅真实调用高德时计数）
    if (window.Quota && !amapMock()) window.Quota.guard();

    // 高德骑行 bicycling 仅提供 v4 接口（响应外壳 errcode/data.paths），步行/驾车为 v3
    var base = (m === "bike") ? "https://restapi.amap.com/v4" : AMAP_BASE;
    var url = base + "/direction/" + MODE_ENDPOINT[m] +
              "?origin=" + encodeURIComponent(from) +
              "&destination=" + encodeURIComponent(to) +
              "&key=" + encodeURIComponent(amapKey());
    var res = await fetch(url);
    var j = await res.json();
    var parsed = parseDirection(j, m);
    if (!parsed || !parsed.duration) {
      var info = (j && (j.info || j.errmsg)) || "无可用路线";
      throw new Error("高德路径规划失败：" + info);
    }
    // 起终点解析到了同一位置（教学楼/宿舍名无法被高德精确识别时会这样），
    // 此时算出的“1 分钟”没有意义 → 抛出，由调用方回退演示值
    if (parsed.distance < 20 || parsed.duration < 60) {
      throw new Error("起终点解析到了同一位置（" + origin + " → " + destination + "），无法计算通勤时间");
    }
    return {
      minutes: Math.max(1, Math.round(parsed.duration / 60)),
      seconds: parsed.duration,
      distance: parsed.distance,
      distanceText: (parsed.distance / 1000).toFixed(1) + " 公里",
      mode: m,
      modeLabel: MODE_LABEL[m],
      source: "amap"
    };
  }

  /**
   * 通勤耗时（分钟）——按需求文档的签名
   * @returns Promise<number>
   */
  async function getCommuteTime(origin, destination, mode) {
    var detail = await getCommuteDetail(origin, destination, mode);
    return detail.minutes;
  }

  // ---- 和风天气 ----
  var MOCK_WEATHER = ["晴", "晴", "多云", "多云", "阴", "小雨", "雷阵雨"];

  function hourOf(fxTime) {
    var m = String(fxTime || "").match(/T(\d{2}):/);
    return m ? (+m[1]) : null;
  }

  function mockWeather(loc, hours) {
    var seed = hash(loc + "|" + new Date().getHours()); // 同一小时内结果稳定
    var cond = MOCK_WEATHER[seed % MOCK_WEATHER.length];
    var raining = cond.indexOf("雨") > -1;
    var temp = 15 + (seed % 12); // 演示用 15~26°C
    var base = raining
      ? "[模拟] 当前" + cond + "，未来 " + hours + " 小时可能有雨，出门记得带伞 🌂"
      : "[模拟] 当前" + cond + "，未来 " + hours + " 小时无雨，放心出门 ☀️";
    return {
      raining: raining,
      text: base + "，当前 " + temp + "°C",
      temp: temp,
      source: "mock",
      hours: hours,
      hourly: []
    };
  }

  /**
   * 天气 / 下雨判断
   * - 新版和风（host 含 qweatherapi.com）：GET {host}/weather/v1/hourly/{lat}/{lon}，
   *   Key 走请求头 X-QW-Api-Key，路径参数为「纬度,经度」
   * - 旧版回退（host 为 devapi/api.qweather.com）：GET {host}/v7/weather/24h?location=lon,lat&key=
   * @param location  "经度,纬度"（GCJ-02 即可，和风按经纬度查询）或地名
   * @param opts      { hours: 未来几小时窗口，默认 6 }
   * @returns Promise<{ raining: boolean, text: string, source: string, hours: number, hourly: [] }>
   */
  async function checkWeather(location, opts) {
    opts = opts || {};
    var hours = opts.hours || 6;
    var loc = String(location || "").trim();
    if (!loc) throw new Error("地点不能为空");

    if (qwMock()) {
      var w = mockWeather(loc, hours);
      console.log("[CommuteAPI][Mock] 天气：", loc, w);
      return w;
    }

    // 和风 location 支持 "lon,lat"；地名先过高德地理编码转坐标
    var coord = loc;
    if (!looksLikeCoords(loc)) {
      try { coord = await toCoords(loc); } catch (e) { coord = loc; }
    }
    var parts = coord.split(",");
    var lon = parseFloat(parts[0]);
    var lat = parseFloat(parts[1]);
    if (!isFinite(lon) || !isFinite(lat)) {
      throw new Error("无法解析地点坐标：" + loc + "（和风天气需要经纬度或地名）");
    }

    var host = qwHost();
    if (!host) {
      throw new Error("和风天气：请先在 config.js 的 QWEATHER_CONFIG.host 填入你的 API Host" +
                      "（和风控制台 → 设置 查看，形如 https://xxxxxxxx.qweatherapi.com）");
    }

    var hourly, rainHour = null;
    if (isNewQWeather()) {
      // ===== 新版：专属 Host + X-QW-Api-Key 请求头 + /weather/v1/hourly/{lat}/{lon} =====
      var url = host + "/weather/v1/hourly/" + lat + "/" + lon +
                "?hours=" + Math.min(240, Math.max(1, hours)) +
                "&lang=" + encodeURIComponent((window.QWEATHER_CONFIG && window.QWEATHER_CONFIG.lang) || "zh") +
                "&localTime=true";
      if (window.Quota) window.Quota.guard(); // 成本控制：每日外部 API 配额
      var res = await fetch(url, { headers: { "X-QW-Api-Key": qwKey() } });
      var j = await res.json();
      if (!res.ok || !j || !j.hours) {
        // 新版错误响应：{ error: { status, title, detail } }
        var err = (j && j.error) || {};
        var msg = err.detail || err.title || (j && j.message) || ("HTTP " + res.status);
        throw new Error("和风天气查询失败：" + msg);
      }
      // 归一成统一结构（text/fxTime），展示与下游复用
      hourly = j.hours.slice(0, hours).map(function (h) {
        var p = h.precipitation || {};
        return {
          text: (h.condition && h.condition.text) || "",
          fxTime: h.forecastTime,
          temp: h.temperature && h.temperature.value,
          pop: p.probability,
          precipType: p.type
        };
      });
      hourly.forEach(function (h) {
        var wet = isWetType(h.precipType) || String(h.text || "").indexOf("雨") > -1;
        var prob = h.pop == null ? 1 : h.pop;
        if (!rainHour && wet && prob >= 0.3) rainHour = h;
      });
    } else {
      // ===== 旧版回退（v7）：?key= 查询参数 + /v7/weather/24h =====
      var url2 = host + "/v7/weather/24h?location=" + encodeURIComponent(coord) +
                 "&key=" + encodeURIComponent(qwKey());
      if (window.Quota) window.Quota.guard(); // 成本控制：每日外部 API 配额
      var res2 = await fetch(url2);
      var j2 = await res2.json();
      if (j2.code !== "200") {
        var msg2 = j2.message || j2.detail || j2.title || ("HTTP " + res2.status);
        throw new Error("和风天气查询失败：" + msg2);
      }
      hourly = (j2.hourly || []).slice(0, hours);
      hourly.forEach(function (h) {
        if (!rainHour && String(h.text || "").indexOf("雨") > -1) rainHour = h;
      });
    }

    var raining = !!rainHour;
    var now = hourly[0] || {};
    // 当日实时气温（来自逐时数据的当前小时温度；和风新老版本字段统一为 .temp）
    // 取整去掉小数（如 22.5°C → 23°C），卡片与对话回复共用该文案
    var tempNow = (now && now.temp != null && !isNaN(Number(now.temp))) ? Math.round(Number(now.temp)) : null;
    var tempStr = tempNow != null ? "，当前 " + tempNow + "°C" : "";
    var text;
    if (raining) {
      var hh = hourOf(rainHour.fxTime);
      // 天气现象文案可能不含“雨”（如“阴”但降水类型为 rain），统一补成“雨”
      var cond = String(rainHour.text || "雨");
      var condText = cond.indexOf("雨") > -1 ? cond : "雨（" + cond + "）";
      text = "⚠️ 预计 " + (hh != null ? hh + " 时" : "未来几小时内") + "有" + condText +
             "，出门记得带伞 🌂" + tempStr;
    } else {
      text = "未来 " + hours + " 小时无雨（" + (now.text || "天气平稳") + "）" + tempStr + "，放心出门 ☀️";
    }
    return { raining: raining, text: text, temp: tempNow, source: "qweather", hours: hourly.length, hourly: hourly };
  }

  /**
   * 合并查询：一次拿到「耗时 + 是否下雨」（供通勤卡片直接使用）
   * 天气失败不影响通勤耗时返回（weatherText 会带上失败原因）
   * @returns Promise<{ minutes, distanceText, modeLabel, raining, weatherText, source }>
   */
  async function getCommuteSummary(origin, destination, mode, location) {
    var detail = await getCommuteDetail(origin, destination, mode);
    var weather;
    try {
      weather = await checkWeather(location || destination, { hours: 6 });
    } catch (e) {
      weather = { raining: false, text: "天气暂不可用（" + e.message + "）", source: "error" };
    }
    return {
      minutes: detail.minutes,
      distanceText: detail.distanceText,
      modeLabel: detail.modeLabel,
      raining: weather.raining,
      weatherText: weather.text,
      weatherOk: weather.source !== "error", // 天气是否真实拿到（false 时调用方应回退演示值）
      source: detail.source === "mock" || weather.source === "mock" ? "mock" : "live"
    };
  }

  // 当前各 API 模式（测试页 / 控制台排查用）
  function status() {
    var qwState;
    if (qwMock()) {
      qwState = "mock（未填 Key，返回模拟天气）";
    } else if (!qwHost()) {
      qwState = "待配置（Key 已填，请在 config.js 填入控制台分配的 API Host）";
    } else {
      qwState = "ready（和风天气）";
    }
    return {
      amap: amapMock() ? "mock（未填 Key，返回模拟耗时）" : "ready（高德 Web服务）",
      qweather: qwState
    };
  }

  return {
    getCommuteTime: getCommuteTime,
    getCommuteDetail: getCommuteDetail,
    checkWeather: checkWeather,
    getCommuteSummary: getCommuteSummary,
    setSchoolContext: setSchoolContext,
    normalizeMode: normalizeMode,
    status: status
  };
})();
