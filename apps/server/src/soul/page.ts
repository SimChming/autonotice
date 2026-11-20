/**
 * /soul：主人的私人页面，用来看她的状态、日记、见闻与活动流水。
 * 纯服务端内联 HTML，不依赖前端构建产物。
 */
export const SOUL_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>鲸鱼娘 · 5.2.0</title>
<style>
  :root {
    --bg: #0f1220; --panel: #171b2e; --panel-2: #1e2439; --line: #2a3150;
    --text: #e8ebf7; --muted: #9aa3c2; --accent: #7c9cff; --warm: #ff9ec4;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: radial-gradient(1200px 600px at 20% -10%, #232a4d 0%, var(--bg) 60%);
    color: var(--text); font: 15px/1.65 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    min-height: 100vh;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 22px; border-bottom: 1px solid var(--line);
    position: sticky; top: 0; backdrop-filter: blur(12px); background: rgba(15,18,32,.75); z-index: 5;
  }
  header h1 { font-size: 17px; margin: 0; letter-spacing: .5px; }
  header h1 span { color: var(--warm); }
  main { max-width: 1240px; margin: 0 auto; padding: 22px; }
  button {
    cursor: pointer; border: 1px solid var(--line); background: var(--panel-2); color: var(--text);
    border-radius: 10px; padding: 8px 14px; font-size: 13px; transition: .15s;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: linear-gradient(135deg, #5f7cff, #9d6bff); border: none; }
  button.warm { background: linear-gradient(135deg, #ff7aa8, #ffb36b); border: none; color: #241426; }
  button:disabled { opacity: .5; cursor: default; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--panel); color: var(--text); font-size: 14px;
  }
  .login { max-width: 380px; margin: 12vh auto; background: var(--panel); padding: 28px; border-radius: 18px; border: 1px solid var(--line); }
  .login h2 { margin: 0 0 6px; font-size: 20px; }
  .login p { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
  .login .row { margin-bottom: 12px; }
  .status { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; margin-bottom: 20px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; }
  .card h3 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 500; letter-spacing: .5px; }
  .mood { font-size: 26px; font-weight: 600; color: var(--warm); }
  .mood small { font-size: 13px; color: var(--muted); font-weight: 400; }
  .bar { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 12px; }
  .bar label { width: 34px; color: var(--muted); flex: none; }
  .bar .track { flex: 1; height: 7px; background: var(--panel-2); border-radius: 99px; overflow: hidden; }
  .bar .fill { height: 100%; background: linear-gradient(90deg, #5f7cff, #c46bff); border-radius: 99px; }
  .bar b { width: 28px; text-align: right; font-weight: 500; color: var(--muted); }
  .grid { display: grid; grid-template-columns: 240px 1fr 300px; gap: 16px; align-items: start; }
  @media (max-width: 1080px) { .grid { grid-template-columns: 220px 1fr; } .side { grid-column: 1 / -1; } }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .list { max-height: 62vh; overflow: auto; }
  .item { padding: 10px 12px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; }
  .item:hover { background: var(--panel-2); }
  .item.active { background: var(--panel-2); border-color: var(--accent); }
  .item .day { font-size: 12px; color: var(--muted); }
  .item .title { font-size: 14px; margin-top: 2px; }
  .journal h2 { margin: 0 0 4px; font-size: 21px; }
  .journal .meta { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .journal .body { white-space: pre-wrap; font-size: 15px; line-height: 1.9; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0 0; }
  .feed { max-height: 30vh; overflow: auto; font-size: 13px; }
  .feed div { padding: 7px 0; border-bottom: 1px dashed var(--line); color: var(--muted); }
  .feed div b { color: var(--text); font-weight: 500; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 99px; background: var(--panel-2); color: var(--muted); margin-right: 6px; }
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .empty { color: var(--muted); font-size: 13px; padding: 20px 0; }
  .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); background: #2a3150; padding: 10px 18px; border-radius: 10px; font-size: 13px; opacity: 0; transition: .25s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .bar .fill.warm { background: linear-gradient(90deg, #ffb86b, #ff7ab6); }
  .mind { padding: 10px 0; border-bottom: 1px dashed var(--line); }
  .mind-kind { font-size: 11px; color: var(--accent); margin-bottom: 3px; }
  .mind-text { font-size: 13px; line-height: 1.6; }
  .mind-progress { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .mind-done { margin-top: 6px; font-size: 11px; padding: 3px 10px; border-radius: 99px; border: 1px solid var(--line); background: transparent; color: var(--muted); cursor: pointer; }
  .feed-item { padding: 7px 0; border-bottom: 1px dashed var(--line); }
  .feed-sum { color: var(--text); font-size: 13px; line-height: 1.6; }
  .feed-src { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .cmd-line {
    font: 12px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
    color: var(--text); word-break: break-all;
  }
  .cmd-out {
    font: 11px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
    color: var(--muted); white-space: pre-wrap; word-break: break-all;
    max-height: 90px; overflow: hidden; margin-top: 4px;
  }
</style>
</head>
<body>
<header>
  <h1>🐋 鲸鱼娘 <span>· 5.2.0</span></h1>
  <div>
    <button id="btn-tick" hidden>让她活动一下</button>
    <button id="btn-journal" hidden>现在写日记</button>
    <button id="btn-logout" hidden>退出</button>
  </div>
</header>
<main>
  <section class="login" id="login">
    <h2>要看看她吗？</h2>
    <p>用后台管理员账号登录。她不会知道你来了，除非你选择留下痕迹。</p>
    <div class="row"><input id="u" placeholder="管理员账号" autocomplete="username" /></div>
    <div class="row"><input id="p" type="password" placeholder="密码" autocomplete="current-password" /></div>
    <button class="primary" id="btn-login" style="width:100%">进入</button>
  </section>

  <section id="app" hidden>
    <div class="status">
      <div class="card">
        <h3>此刻的心情</h3>
        <div class="mood" id="mood">—</div>
        <div style="color:var(--muted);font-size:12px;margin-top:6px" id="energy">精力 —</div>
        <h3 style="margin-top:16px">此刻被什么推着</h3>
        <div id="drives"></div>
      </div>
      <div class="card" style="grid-column: span 2">
        <h3>性格倾向（会随每天接触的信息缓慢变化）</h3>
        <div id="traits"></div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>日记</h3>
        <div class="list" id="journals"><div class="empty">还没有日记</div></div>
      </div>
      <div class="card journal" id="detail">
        <div class="empty">左边选一篇日记看看。</div>
      </div>
      <div class="side">
        <div class="card" style="margin-bottom:16px">
          <h3>她的手（宿主机 root）</h3>
          <div class="feed" id="commands"><div class="empty">还没动过手</div></div>
          <div class="row" style="margin-top:10px;display:flex;gap:8px">
            <input id="todo" placeholder="让她去做一件事…" style="flex:1" />
            <button id="btn-todo" style="white-space:nowrap">让她去</button>
          </div>
        </div>
        <div class="card" style="margin-bottom:16px">
          <h3>她心里挂着的事</h3>
          <div class="feed" id="intentions"><div class="empty">还没有</div></div>
          <div class="row" style="margin-top:10px;display:flex;gap:8px">
            <input id="seed" placeholder="往她心里放一件事…" style="flex:1" />
            <button id="btn-seed" style="white-space:nowrap">让她记住</button>
          </div>
        </div>
        <div class="card" style="margin-bottom:16px">
          <h3>她对自己的认识</h3>
          <div class="feed" id="reflections"><div class="empty">还没有</div></div>
        </div>
        <div class="card" style="margin-bottom:16px">
          <h3>今天看到的东西</h3>
          <div class="feed" id="readings"><div class="empty">还没有</div></div>
        </div>
        <div class="card">
          <h3>她最近在做的事</h3>
          <div class="feed" id="events"><div class="empty">还没有</div></div>
        </div>
      </div>
    </div>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
(function () {
  var token = localStorage.getItem("soul_token") || "";
  var currentDay = "";
  var el = function (id) { return document.getElementById(id); };
  function toast(text) {
    var node = el("toast");
    node.textContent = text;
    node.classList.add("show");
    setTimeout(function () { node.classList.remove("show"); }, 1800);
  }
  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {});
    if (options.body) { options.headers["Content-Type"] = "application/json"; }
    if (token) { options.headers.Authorization = "Bearer " + token; }
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && path.indexOf("/admin/login") < 0) {
          token = "";
          localStorage.removeItem("soul_token");
          el("app").hidden = true;
          el("login").hidden = false;
          el("btn-tick").hidden = true;
          el("btn-journal").hidden = true;
          el("btn-logout").hidden = true;
          toast("登录过期了，再进一次就好");
          throw new Error("登录已过期");
        }
        if (!res.ok) { throw new Error(data.message || ("HTTP " + res.status)); }
        return data;
      });
    });
  }
  function showApp() {
    el("login").hidden = true;
    el("app").hidden = false;
    el("btn-tick").hidden = false;
    el("btn-journal").hidden = false;
    el("btn-logout").hidden = false;
  }
  function fmt(iso) {
    try { return new Date(iso).toLocaleString("zh-CN", { hour12: false }); } catch (e) { return iso; }
  }
  function esc(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function loadState() {
    return api("/api/v1/admin/soul/state").then(function (s) {
      el("mood").textContent = s.mood;
      el("energy").textContent = "精力 " + s.energy + "/100 · 心情浓度 " + s.moodIntensity + "/100";
      el("traits").innerHTML = s.traitsList.map(function (t) {
        return '<div class="bar"><label>' + t.label + '</label><div class="track"><div class="fill" style="width:' + t.value + '%"></div></div><b>' + t.value + '</b></div>';
      }).join("");
      el("drives").innerHTML = (s.drives || []).map(function (d) {
        return '<div class="bar"><label>' + d.label + '</label><div class="track"><div class="fill warm" style="width:' + d.level + '%"></div></div><b>' + d.level + '</b></div>';
      }).join("");

      var box = el("intentions");
      if (!(s.intentions || []).length) {
        box.innerHTML = '<div class="empty">她心里现在空着</div>';
      } else {
        box.innerHTML = s.intentions.map(function (i) {
          var last = i.progress ? i.progress.split("\\n").slice(-1)[0] : "";
          return '<div class="mind"><div class="mind-kind">' + i.kindLabel + '</div>' +
            '<div class="mind-text">' + i.text + '</div>' +
            (last ? '<div class="mind-progress">' + last + '</div>' : '') +
            '<button class="mind-done" data-id="' + i.id + '">放下了</button></div>';
        }).join("");
        Array.prototype.forEach.call(box.querySelectorAll(".mind-done"), function (node) {
          node.addEventListener("click", function () {
            api("/api/v1/admin/soul/intention/" + node.getAttribute("data-id") + "/done", { method: "POST" })
              .then(function () { toast("她从心里放下了"); loadState(); })
              .catch(function (e) { toast(e.message); });
          });
        });
      }

      var rbox = el("reflections");
      if (!(s.reflections || []).length) {
        rbox.innerHTML = '<div class="empty">她还没想清楚自己是谁</div>';
      } else {
        rbox.innerHTML = s.reflections.map(function (r) {
          return '<div class="feed-item"><div class="feed-sum">' + r.content + '</div><div class="feed-src">' + r.day + '</div></div>';
        }).join("");
      }
    });
  }

  function loadJournals() {
    return api("/api/v1/admin/soul/journals?limit=60").then(function (data) {
      var box = el("journals");
      if (!data.items.length) { box.innerHTML = '<div class="empty">还没有日记</div>'; return; }
      box.innerHTML = data.items.map(function (j) {
        return '<div class="item" data-day="' + j.day + '"><div class="day">' + j.day + '</div><div class="title">' + (j.title || "无题") + '</div></div>';
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".item"), function (node) {
        node.addEventListener("click", function () { openDay(node.getAttribute("data-day")); });
      });
      if (!currentDay) { openDay(data.items[0].day); }
    });
  }

  function openDay(day) {
    currentDay = day;
    Array.prototype.forEach.call(document.querySelectorAll(".item"), function (node) {
      node.classList.toggle("active", node.getAttribute("data-day") === day);
    });
    api("/api/v1/admin/soul/journals/" + day).then(function (j) {
      el("detail").innerHTML =
        '<h2>' + (j.title || "无题") + '</h2>' +
        '<div class="meta">' + j.day + ' · 写于 ' + fmt(j.createdAt) + (j.mood ? ' · 心情：' + j.mood : '') + '</div>' +
        '<div class="body">' + j.body.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</div>' +
        '<div class="actions">' +
          '<button class="warm" id="visit-tell">让她知道我看过了</button>' +
          '<button id="visit-silent">偷偷看，不留痕迹</button>' +
        '</div>';
      el("visit-tell").addEventListener("click", function () { visit(day, true); });
      el("visit-silent").addEventListener("click", function () { visit(day, false); });
    }).catch(function (error) { toast(error.message); });
  }

  function visit(day, tell) {
    api("/api/v1/admin/soul/visit", { method: "POST", body: JSON.stringify({ day: day, tell: tell }) })
      .then(function () {
        toast(tell ? "她知道你来过了" : "你悄悄看过了");
        loadEvents();
      })
      .catch(function (error) { toast(error.message); });
  }

  function loadReadings() {
    return api("/api/v1/admin/soul/readings?limit=20").then(function (data) {
      var box = el("readings");
      if (!data.items.length) { box.innerHTML = '<div class="empty">还没有</div>'; return; }
      box.innerHTML = data.items.map(function (r) {
        var title = r.title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        return '<div><span class="tag">' + r.source + '</span><b>' + title + '</b></div>';
      }).join("");
    });
  }

  function loadEvents() {
    return api("/api/v1/admin/soul/events?limit=30").then(function (data) {
      var box = el("events");
      if (!data.items.length) { box.innerHTML = '<div class="empty">还没有</div>'; return; }
      box.innerHTML = data.items.map(function (e) {
        var text = e.content.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        return '<div><span class="tag">' + e.kind + '</span>' + text + '</div>';
      }).join("");
    });
  }

  function loadCommands() {
    return api("/api/v1/admin/soul/commands?limit=12").then(function (data) {
      var box = el("commands");
      if (!data.items.length) { box.innerHTML = '<div class="empty">还没动过手</div>'; return; }
      box.innerHTML = data.items.map(function (c) {
        var head = '<div class="feed-item"><div class="cmd-line">$ ' + esc(c.command) + '</div>' +
          '<div class="feed-src">' + (c.ok ? "成功" : "失败") + ' · ' + c.durationMs + 'ms · ' +
          (c.trigger === "owner" ? "你让她做的" : "她自己想做") +
          (c.reason ? ' · ' + esc(c.reason.slice(0, 40)) : "") + '</div>';
        var out = c.output ? '<div class="cmd-out">' + esc(c.output.slice(0, 300)) + '</div>' : '';
        return head + out + '</div>';
      }).join("");
    });
  }

  function refresh() {
    loadState().catch(function () {});
    loadJournals().catch(function () {});
    loadReadings().catch(function () {});
    loadEvents().catch(function () {});
    loadCommands().catch(function () {});
  }

  el("btn-login").addEventListener("click", function () {
    var u = el("u").value.trim();
    var p = el("p").value;
    if (!u || !p) { toast("先填账号密码"); return; }
    var btn = el("btn-login");
    btn.disabled = true;
    btn.textContent = "正在进…";
    api("/api/v1/admin/login", { method: "POST", body: JSON.stringify({ username: u, password: p }) })
      .then(function (data) {
        token = data.token;
        localStorage.setItem("soul_token", token);
        showApp();
        refresh();
      })
      .catch(function (error) {
        toast("进不去：" + error.message);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = "进入";
      });
  });

  // 输完密码直接回车也能进，不用去找按钮。
  ["u", "p"].forEach(function (id) {
    el(id).addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        el("btn-login").click();
      }
    });
  });

  el("btn-logout").addEventListener("click", function () {
    token = "";
    localStorage.removeItem("soul_token");
    location.reload();
  });

  el("btn-seed").addEventListener("click", function () {
    var text = (el("seed").value || "").trim();
    if (!text) { toast("先写一件想让她记住的事"); return; }
    api("/api/v1/admin/soul/intention", { method: "POST", body: JSON.stringify({ text: text, kind: "promise", priority: 80 }) })
      .then(function () { el("seed").value = ""; toast("她记下了"); loadState(); })
      .catch(function (error) { toast(error.message); });
  });

  el("btn-todo").addEventListener("click", function () {
    var text = (el("todo").value || "").trim();
    if (!text) { toast("先写一件想让她做的事"); return; }
    var btn = el("btn-todo");
    btn.disabled = true;
    btn.textContent = "她在做…";
    api("/api/v1/admin/soul/command", { method: "POST", body: JSON.stringify({ instruction: text }) })
      .then(function (data) {
        el("todo").value = "";
        toast(data.ok ? "她做完了" : "她试了，但没成功");
        loadCommands();
      })
      .catch(function (error) { toast("没做成：" + error.message); })
      .then(function () { btn.disabled = false; btn.textContent = "让她去"; });
  });

  el("todo").addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      el("btn-todo").click();
    }
  });

  el("btn-tick").addEventListener("click", function () {
    api("/api/v1/admin/soul/tick", { method: "POST" })
      .then(function () { toast("她去忙自己的了"); setTimeout(refresh, 3000); })
      .catch(function (error) { toast(error.message); });
  });

  el("btn-journal").addEventListener("click", function () {
    api("/api/v1/admin/soul/journal", { method: "POST", body: JSON.stringify({ force: true }) })
      .then(function (data) { toast(data.wrote ? "写好啦" : "今天已经写过了"); loadJournals(); loadState(); })
      .catch(function (error) { toast(error.message); });
  });

  if (token) {
    showApp();
    refresh();
  }
})();
</script>
</body>
</html>`;
