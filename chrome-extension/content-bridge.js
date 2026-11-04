/**
 * X-Fan Audit - ISOLATED World Content Bridge (content-bridge.js)
 * 负责接收 page-hook.js 捕获的数据批次并转发给 background.js 存入无限容量 chrome.storage.local，
 * 同时在 X 页面提供可折叠悬浮胶囊，支持一键启动/停止「90秒增量巡检」与打开「双榜审计大屏」。
 */
(function () {
  if (window.__XFAN_BRIDGE_LOADED__) return;
  window.__XFAN_BRIDGE_LOADED__ = true;

  let badgeEl = null;
  let minimized = false;
  let patrolRunning = false;
  let lastStats = { following: 0, followers: 0, tweets: 0, likes: 0, me: "" };

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__xfan_type) return;
    const type = ev.data.__xfan_type;
    if (type === "XFAN_BATCH" || type === "XFAN_MIGRATE_LEGACY" || type === "XFAN_ME_HANDLE") {
      const migrateSig = type === "XFAN_MIGRATE_LEGACY" ? ev.data.sig : "";
      try {
        chrome.runtime.sendMessage(
          { type, payload: ev.data.payload },
          (res) => {
            if (chrome.runtime.lastError) return;
            if (res && res.stats) {
              lastStats = res.stats;
              updateBadge();
              // 后台确认写入成功，才让页面记下「已迁移」，失败了下次还会重试
              if (migrateSig) {
                window.postMessage({ __xfan_type: "XFAN_MIGRATE_ACK", sig: migrateSig }, "*");
              }
            }
          }
        );
      } catch (e) {}
    }
  });

  // 接收 background.js 发来的滚动指令与巡检状态更新
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "XFAN_DO_SCROLL") {
      try {
        window.scrollTo(0, document.documentElement.scrollHeight);
        const boxes = document.querySelectorAll('main, [data-testid="primaryColumn"]');
        boxes.forEach((b) => {
          try {
            b.scrollTop = b.scrollHeight;
          } catch (e) {}
        });
        window.dispatchEvent(new WheelEvent("wheel", { deltaY: 1400, bubbles: true }));
      } catch (e) {}
      sendResponse({ ok: true, url: location.href });
      return true;
    }
    if (msg.type === "XFAN_PATROL_STATUS") {
      if (msg.stats) lastStats = msg.stats;
      if (typeof msg.patrolRunning === "boolean") patrolRunning = msg.patrolRunning;
      updateBadge(msg.statusText);
      sendResponse({ ok: true });
      return true;
    }
  });

  function createBadge() {
    if (badgeEl || !document.body) return;
    badgeEl = document.createElement("div");
    badgeEl.id = "xfan-ext-floating-badge";
    badgeEl.style.cssText =
      "position:fixed;right:18px;bottom:68px;z-index:2147483646;background:rgba(15,23,42,0.95);" +
      "color:#f8fafc;padding:10px 13px;border-radius:12px;font:12px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "box-shadow:0 8px 28px rgba(0,0,0,0.38);border:1px solid rgba(56,189,248,0.32);backdrop-filter:blur(8px);" +
      "min-width:218px;user-select:none;transition:all 0.2s;";

    // 版本号只从 manifest 读，避免升级后忘记改这里
    let ver = "";
    try { ver = " v" + chrome.runtime.getManifest().version; } catch (e) {}
    badgeEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <strong style="color:#38bdf8;font-size:12.5px;cursor:pointer;" id="xfan-title-toggle" title="点击折叠/展开">⚡ X-Fan 铁粉审计${ver}</strong>
        <div style="display:flex;align-items:center;gap:6px;">
          <span id="xfan-ext-me" style="color:#94a3b8;font-size:11px;"></span>
          <button id="xfan-btn-min" style="border:0;background:rgba(148,163,184,0.18);color:#cbd5e1;border-radius:4px;padding:0 5px;cursor:pointer;font-size:11px;line-height:16px;" title="最小化/展开">—</button>
        </div>
      </div>
      <div id="xfan-ext-body" style="margin-top:6px;">
        <div id="xfan-ext-counts" style="color:#cbd5e1;font-size:11.5px;margin-bottom:6px;">正在同步本地库...</div>
        <div id="xfan-ext-patrol-msg" style="display:none;color:#fbbf24;font-size:11px;margin-bottom:6px;"></div>
        <div style="display:flex;gap:6px;">
          <button id="xfan-btn-inc" style="flex:1;padding:5px 8px;border:0;border-radius:6px;background:#0284c7;color:#fff;cursor:pointer;font-size:11.5px;font-weight:600;">⚡ 90s增量</button>
          <button id="xfan-btn-dash" style="flex:1;padding:5px 8px;border:0;border-radius:6px;background:#10b981;color:#fff;cursor:pointer;font-size:11.5px;font-weight:600;">📊 双榜大屏</button>
        </div>
      </div>
    `;
    document.body.appendChild(badgeEl);

    const toggleMin = () => {
      minimized = !minimized;
      const body = badgeEl.querySelector("#xfan-ext-body");
      const btn = badgeEl.querySelector("#xfan-btn-min");
      if (body) body.style.display = minimized ? "none" : "block";
      if (btn) btn.textContent = minimized ? "+" : "—";
      badgeEl.style.minWidth = minimized ? "auto" : "218px";
    };
    badgeEl.querySelector("#xfan-btn-min").addEventListener("click", toggleMin);
    badgeEl.querySelector("#xfan-title-toggle").addEventListener("click", toggleMin);

    badgeEl.querySelector("#xfan-btn-inc").addEventListener("click", () => {
      if (patrolRunning) {
        chrome.runtime.sendMessage({ type: "XFAN_STOP_PATROL" });
      } else {
        chrome.runtime.sendMessage({ type: "XFAN_START_PATROL", mode: "incremental" });
      }
    });
    badgeEl.querySelector("#xfan-btn-dash").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "XFAN_OPEN_DASHBOARD" });
    });

    chrome.runtime.sendMessage({ type: "XFAN_GET_STATS" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.stats) {
        lastStats = res.stats;
        patrolRunning = Boolean(res.patrolRunning);
        updateBadge(res.patrolStatus || "");
      }
    });
  }

  function updateBadge(patrolText) {
    if (!badgeEl) createBadge();
    if (!badgeEl) return;
    if (location.pathname.indexOf("/compose") === 0) {
      badgeEl.style.display = "none";
      return;
    }
    badgeEl.style.display = "block";
    const meNode = badgeEl.querySelector("#xfan-ext-me");
    const cntNode = badgeEl.querySelector("#xfan-ext-counts");
    const msgNode = badgeEl.querySelector("#xfan-ext-patrol-msg");
    const incBtn = badgeEl.querySelector("#xfan-btn-inc");
    if (meNode) meNode.textContent = lastStats.me ? "@" + lastStats.me : "";
    if (cntNode) {
      cntNode.textContent = `粉 ${lastStats.followers || 0} · 关 ${lastStats.following || 0} · 推 ${lastStats.tweets || 0} · 赞 ${lastStats.likes || 0}`;
    }
    if (incBtn) {
      incBtn.textContent = patrolRunning ? "⏹ 停止巡检" : "⚡ 90s增量";
      incBtn.style.background = patrolRunning ? "#e11d48" : "#0284c7";
    }
    if (msgNode) {
      if (patrolText) {
        msgNode.style.display = "block";
        msgNode.textContent = patrolText;
      } else {
        msgNode.style.display = "none";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createBadge);
  } else {
    createBadge();
  }
})();
