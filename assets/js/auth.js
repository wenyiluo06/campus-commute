/* ===================================================================
   认证页逻辑：邮箱 + 密码 注册 / 登录 / 忘记密码
   - 依赖 supabase.js 暴露的 window.sb（已初始化的 supabase 客户端）
   - 登录 / 注册成功 → 不再按 ?next= 回跳，而是走 AppAuth.resolveLanding()
     做路由分发：新用户（表里没数据）→ setup.html；老用户 → index.html。
   - 已登录用户再打开认证页 → 直接分发，不再显示登录表单。
   =================================================================== */
(function () {
  "use strict";

  var client = window.sb;
  if (!client) {
    console.error("[auth] supabase 客户端未初始化（请确认 supabase.js 已加载）");
    return;
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "auth-msg" + (kind === "ok" ? " ok" : text ? " err" : "");
  }

  function getNext() {
    try {
      var p = new URLSearchParams(location.search).get("next");
      if (p && p.indexOf("://") === -1) return p; // 仅允许同站相对路径
    } catch (e) {}
    return "index.html";
  }

  // 登录 / 注册成功后的去向：优先路由分发；没有 AppAuth 时退化为 ?next=
  function goLanding() {
    if (window.AppAuth && window.AppAuth.resolveLanding) {
      window.AppAuth.resolveLanding();
    } else {
      location.replace(getNext());
    }
  }

  // ---- 视图切换 ----
  var tabs = document.querySelectorAll(".auth-tab");
  var views = {
    login: document.getElementById("view-login"),
    register: document.getElementById("view-register"),
    forgot: document.getElementById("view-forgot")
  };
  function showView(name) {
    Object.keys(views).forEach(function (k) {
      if (views[k]) views[k].classList.toggle("active", k === name);
    });
    tabs.forEach(function (t) {
      t.classList.toggle("active", t.dataset.view === name);
    });
  }
  tabs.forEach(function (t) {
    t.addEventListener("click", function () { showView(t.dataset.view); });
  });
  var toForgot = document.getElementById("toForgot");
  if (toForgot) toForgot.addEventListener("click", function () { showView("forgot"); });
  var backToLogin = document.getElementById("backToLogin");
  if (backToLogin) backToLogin.addEventListener("click", function () { showView("login"); });

  // 如果带 ?reset=1（从重置邮件回来），提示用户直接登录
  var isResetReturn = false;
  try {
    isResetReturn = new URLSearchParams(location.search).get("reset") === "1";
    if (isResetReturn) {
      setMsg(document.getElementById("loginMsg"), "密码已重置，请用新密码登录", "ok");
    }
  } catch (e) {}

  // 已登录用户打开认证页 → 直接按路由分发（重置邮件回来时不抢跳，保留提示）
  if (!isResetReturn) {
    client.auth.getSession().then(function (r) {
      if (r && r.data && r.data.session) goLanding();
    }).catch(function () {});
  }

  // ---- 登录 ----
  var loginForm = document.getElementById("view-login");
  if (loginForm) {
    loginForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = document.getElementById("loginEmail").value.trim();
      var pwd = document.getElementById("loginPassword").value;
      var msg = document.getElementById("loginMsg");
      if (!EMAIL_RE.test(email)) { setMsg(msg, "请输入正确的邮箱"); return; }
      if (!pwd) { setMsg(msg, "请输入密码"); return; }
      setMsg(msg, "登录中…");
      var r = await client.auth.signInWithPassword({ email: email, password: pwd });
      if (r.error) { setMsg(msg, r.error.message || "登录失败"); return; }
      setMsg(msg, "登录成功，正在跳转…", "ok");
      setTimeout(goLanding, 300);
    });
  }

  // ---- 注册 ----
  var regForm = document.getElementById("view-register");
  if (regForm) {
    regForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = document.getElementById("regEmail").value.trim();
      var pwd = document.getElementById("regPassword").value;
      var confirm = document.getElementById("regConfirm").value;
      var msg = document.getElementById("regMsg");
      if (!EMAIL_RE.test(email)) { setMsg(msg, "请输入正确的邮箱"); return; }
      if (pwd.length < 6) { setMsg(msg, "密码至少 6 位"); return; }
      if (pwd !== confirm) { setMsg(msg, "两次输入的密码不一致"); return; }
      setMsg(msg, "注册中…");
      var r = await client.auth.signUp({ email: email, password: pwd });
      if (r.error) { setMsg(msg, r.error.message || "注册失败"); return; }
      // 若开启了“邮箱确认”，session 为空，需要去邮箱验证
      if (!r.data || !r.data.session) {
        setMsg(msg, "注册成功！请查收验证邮件，确认后再登录", "ok");
        showView("login");
        return;
      }
      setMsg(msg, "注册成功，正在跳转…", "ok");
      setTimeout(goLanding, 300);
    });
  }

  // ---- 忘记密码 ----
  var forgotForm = document.getElementById("view-forgot");
  if (forgotForm) {
    forgotForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = document.getElementById("forgotEmail").value.trim();
      var msg = document.getElementById("forgotMsg");
      if (!EMAIL_RE.test(email)) { setMsg(msg, "请输入正确的邮箱"); return; }
      setMsg(msg, "发送中…");
      var r = await client.auth.resetPasswordForEmail(email, {
        redirectTo: location.origin + "/auth.html?reset=1"
      });
      if (r.error) { setMsg(msg, r.error.message || "发送失败"); return; }
      setMsg(msg, "重置邮件已发送，请查收（含有效期，请尽快操作）", "ok");
    });
  }
})();
