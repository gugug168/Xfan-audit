/**
 * X-Fan Audit - Standalone Dashboard Controller (dashboard.js)
 * 支持：
 * 1. 受邀回访榜 / 自来水铁粉榜 / 未回关清理表（带头像展示与 CSV 导出）
 * 2. 海报独立出图模式：可单独生成「🎯 认真回访铁粉榜」、「🔥 自来水真爱榜」或「🏆 双榜合体图」，
 *    1600px 超清宽幅大字卡片 + 真实圆形头像（只用已采集的 pbs.twimg.com 头像，缺失时显示首字母徽章，不请求第三方）。
 */
(function () {
  "use strict";

  let rawDb = null;
  let auditResult = null;
  let currentTab = "return";
  let currentTier = "ALL";
  let searchQuery = "";
  let posterLayout = "circle_cards"; // "circle_cards" | "circle_only" | "cards_only"
  let posterMode = "return";     // "return" | "natural" | "both"
  let posterTierMode = "SA";     // "S" | "SA" | "SAB" | "ALL"
  let posterLimit = 20;          // 5 | 8 | 10 | 12 | 16 | 20 | 30 | 999 | 自定义数字

  // 海报全局文字自定义与单人卡片自定义缓存
  const posterTextCustom = {
    title: "",
    sub: "",
    footer: "",
  };
  // key: `${boardType}:${account}` -> { excluded: boolean, name: string, detail: string }
  const userCardCustom = new Map();

  // 内存头像缓存：handle -> ImageBitmap | "loading" | "failed"
  const avatarBitmapCache = new Map();
  let posterRenderTimer = null;

  const kpiGrid = document.getElementById("kpi-grid");
  const tableContainer = document.getElementById("table-container");
  const shareContainer = document.getElementById("share-container");
  const tableToolbar = document.getElementById("table-toolbar");
  const tierPills = document.getElementById("tier-pills");
  const statusLine = document.getElementById("status-line");
  const meBadge = document.getElementById("me-badge");
  const searchInput = document.getElementById("search-input");

  // 头像加载失败时隐藏 <img>，露出底下的首字母。
  // 不能写内联 onerror：扩展页默认 CSP（script-src 'self'）会拦截内联事件处理器。
  // error 事件不冒泡，所以用捕获阶段在容器上统一监听。
  tableContainer.addEventListener(
    "error",
    (ev) => {
      const t = ev.target;
      if (t && t.tagName === "IMG" && t.classList.contains("xf-avatar")) t.style.display = "none";
    },
    true
  );

  // 评分参数的展示值：从 config.json 读到的 runtimeCfg 为准，读不到就用默认值。
  // 表头和说明文字不再写死 ×40 / +8，改了配置后界面跟着变。
  function cfgNum(path, fallback) {
    let v = runtimeCfg;
    for (const k of path) v = v && v[k];
    return typeof v === "number" ? v : fallback;
  }
  function fmtNum(n) {
    return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  }
  const pts = {
    reply: () => fmtNum(cfgNum(["combo", "original_reply"], 40)),
    thread: () => fmtNum(cfgNum(["combo", "thread_reply"], 12)),
    like: () => fmtNum(cfgNum(["combo", "original_like"], 4)),
    chat: () => fmtNum(cfgNum(["combo", "chat_day"], 1)),
    follows: () => cfgNum(["base", "follows_me"], 5),
    mutual: () => cfgNum(["base", "follows_me"], 5) + cfgNum(["base", "mutual"], 3),
  };

  // 本周新增徽标：0 分不显示，避免满屏 +0
  function weekBadge(r) {
    const v = Number(r.week_earned || 0);
    if (!(v > 0)) return "";
    return `<div style="font-size:11px;font-weight:600;color:#34d399;" title="本周（周一 0 点起）新增的互动得分，不含基础分">本周 +${fmtNum(v)}</div>`;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function avatarHtml(r) {
    const initial = ((r.name || r.account || "?").trim()[0] || "?").toUpperCase();
    // 只用插件自己在 x.com 上采到的头像；没有就显示首字母。
    // 不再回退到第三方 unavatar.io：那会把你粉丝的账号名逐个发给第三方服务。
    const url = r.avatar || "";
    return `
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="position:relative;width:38px;height:38px;flex-shrink:0;border-radius:50%;background:#1e293b;display:flex;align-items:center;justify-content:center;font-weight:700;color:#38bdf8;overflow:hidden;border:1.5px solid rgba(56,189,248,0.35);">
          <span>${escapeHtml(initial)}</span>
          <img class="xf-avatar" src="${escapeHtml(url)}" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" />
        </div>
        <div>
          <a class="user-link" href="https://x.com/${escapeHtml(r.account)}" target="_blank">@${escapeHtml(r.account)}</a>
          ${r.verified ? '<span style="color:#38bdf8;" title="蓝V认证">✓</span>' : ""}
          <div style="color:var(--muted);font-size:11.5px;">${escapeHtml(r.name)} ${r.followers ? `· ${r.followers.toLocaleString()} 粉` : ""}</div>
        </div>
      </div>
    `;
  }

  let seedMergedOnce = false;
  let runtimeCfg = null;

  function currentSeedKey() {
    try {
      return "seed@" + chrome.runtime.getManifest().version;
    } catch (e) {
      return "seed@unknown";
    }
  }

  function mergeSeedIntoDb(targetDb, seed) {
    if (!seed) return targetDb;
    if (!targetDb.lists) targetDb.lists = { following: {}, followers: {} };
    if (!targetDb.users) targetDb.users = {};
    if (!targetDb.tweets) targetDb.tweets = {};
    if (!targetDb.likes) targetDb.likes = {};
    targetDb.me = targetDb.me || seed.me || "";

    // 名单是「某一时刻的快照」，不是只增的历史事实：库里已有名单时，seed 里的旧名单
    // 会把早已取关/回关的人重新加回来。所以只在对应名单为空（新装）时才采用 seed 的。
    ["following", "followers"].forEach((k) => {
      if (!targetDb.lists[k]) targetDb.lists[k] = {};
      if (Object.keys(targetDb.lists[k]).length > 0) return;
      Object.keys((seed.lists && seed.lists[k]) || {}).forEach((h) => {
        targetDb.lists[k][h.toLowerCase()] = 1;
      });
    });
    Object.entries(seed.users || {}).forEach(([h, u]) => {
      const k = h.toLowerCase();
      const prev = targetDb.users[k] || {};
      targetDb.users[k] = {
        id: prev.id || u.id || "",
        handle: k,
        name: prev.name || u.name || "",
        avatar: prev.avatar || u.avatar || "",
        followers: prev.followers || u.followers || 0,
        following: prev.following || u.following || 0,
        verified: Boolean(prev.verified || u.verified),
        created: prev.created || u.created || "",
      };
    });
    Object.entries(seed.tweets || {}).forEach(([tid, t]) => {
      if (!targetDb.tweets[tid]) {
        targetDb.tweets[tid] = t;
      } else if (!targetDb.tweets[tid].author && t.author) {
        targetDb.tweets[tid].author = t.author;
      }
    });
    // 走与后台完全相同的合并规则，避免第三份实现
    (window.XFanMerge || {}).mergeDb
      ? window.XFanMerge.mergeDb(targetDb, { likes: seed.likes || {} })
      : Object.entries(seed.likes || {}).forEach(([nid, ev]) => {
          if (!targetDb.likes[nid]) targetDb.likes[nid] = ev;
        });
    return targetDb;
  }

  function loadAndRender() {
    try {
      const verEl = document.getElementById("ver-badge");
      if (verEl && chrome.runtime && chrome.runtime.getManifest) {
        verEl.textContent = "v" + chrome.runtime.getManifest().version;
      }
    } catch (e) {}
    chrome.runtime.sendMessage({ type: "XFAN_GET_FULL_DB" }, async (res) => {
      let db = (res && res.db) || {
        me: "",
        lists: { following: {}, followers: {} },
        users: {},
        tweets: {},
        likes: {},
      };

      // seed 每个扩展版本只导入一次，由库里的 seed_version 记录。
      // 原先用「推文数 < 3000 或头像数 < 1450」这种魔法数字判断：达不到的账号
      // 每次刷新大屏都会重新拉 2MB 文件、合并、再把整库写回一遍。
      //
      // seed 是某一个账号（seed.me）的快照，只有「库里已经识别出同一个账号」才能合并。
      // 库里 me 为空（全新安装）时一律不合并：否则任何人装上都会看到别人的粉丝和推文，
      // 并且 db.me 被设成别人，之后的巡检会去爬别人的账号。
      // me 为空时也不记 seed_version，等用户打开过 x.com、识别出账号后下次再判断。
      const seedKey = currentSeedKey();
      if (!seedMergedOnce && db.me && db.seed_version !== seedKey) {
        seedMergedOnce = true;
        // 只记下「这个版本的 seed 已处理过」，下次打开大屏不再请求
        const markSeedHandled = () => {
          db.seed_version = seedKey;
          chrome.runtime.sendMessage({ type: "XFAN_IMPORT_JSON", payload: { seed_version: seedKey } });
        };
        let seedData = null;
        try {
          // 发布版不带 seed 文件。扩展包内文件不存在时 fetch 直接抛错（不是返回 404 响应），
          // 所以「没有文件」要在 catch 里处理；原先 catch 为空，导致每次打开大屏都重新请求一次。
          const seedResp = await fetch("./seed-baseline.json");
          if (seedResp.ok) seedData = await seedResp.json();
        } catch (e) {
          seedData = null;
        }
        if (seedData && seedData.me && seedData.me === db.me) {
          db = mergeSeedIntoDb(db, seedData);
          db.seed_version = seedKey;
          chrome.runtime.sendMessage({ type: "XFAN_IMPORT_JSON", payload: db });
        } else {
          // 没有文件 / 文件损坏 / 账号不一致：都不合并，只记一次
          markSeedHandled();
        }
      }

      rawDb = db;
      const me = rawDb.me || "";
      meBadge.textContent = me ? "@" + me : "未识别账号（请先在 x.com 打开一次你的主页）";
      // 评分参数从扩展包内的 config.json 读（与 Xfan-audit/config.json 由测试锁死），
      // 否则 known_qt_authors 会在 JS 与 Python 两侧各存一份、改一边等于没改
      if (!runtimeCfg) {
        try {
          const cfgResp = await fetch("./config.json");
          if (cfgResp.ok) runtimeCfg = (await cfgResp.json()).return_visit || null;
        } catch (e) {}
      }
      auditResult = window.XFanScorer.auditFromRawDb(rawDb, me, runtimeCfg);

      const s = auditResult.summary;
      const emptyGuide = document.getElementById("empty-guide");
      if (emptyGuide) {
        emptyGuide.style.display = s.total_tweets === 0 && s.followers === 0 ? "block" : "none";
      }
      const stopBtn = document.getElementById("btn-patrol-stop");
      if (stopBtn && res && res.patrolState) {
        stopBtn.style.display = res.patrolState.running ? "inline-flex" : "none";
      }
      const updatedStr = rawDb.updated_at
        ? new Date(rawDb.updated_at).toLocaleString("zh-CN")
        : "刚刚";
      statusLine.textContent =
        res && res.patrolState && res.patrolState.running && res.patrolState.statusText
          ? res.patrolState.statusText
          : `本地无限存储库最后更新：${updatedStr} · 已采推文 ${s.total_tweets} 条（含你的原创主帖 ${s.my_original_posts} 篇）· 原创帖净点赞 ${s.clean_orig_likes} 次`;

      renderKpis(s);
      renderCurrentView();
    });
  }

  function renderKpis(s) {
    kpiGrid.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">互关好友 / 粉丝总数</div>
        <div class="kpi-val" style="color:#38bdf8;">${s.mutual} <span style="font-size:14px;color:var(--muted);">/ ${s.followers}</span></div>
        <div class="kpi-sub">关注 ${s.following} 人 · 互关率 ${s.following ? Math.round((s.mutual / s.following) * 100) : 0}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">榜一：受邀回访 S / A 档</div>
        <div class="kpi-val" style="color:#fbbf24;">${s.return_counts.S} <span style="font-size:15px;color:#34d399;">/ ${s.return_counts.A} 人</span></div>
        <div class="kpi-sub">主动出击 7 天内回访原创帖 · 共 ${s.return_counts.total} 人</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">榜二：自来水铁粉 S / A 档</div>
        <div class="kpi-val" style="color:#a855f7;">${s.natural_counts.S} <span style="font-size:15px;color:#34d399;">/ ${s.natural_counts.A} 人</span></div>
        <div class="kpi-sub">未受外部触达主动登门 · 共 ${s.natural_counts.total} 人</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">已采你的原创主帖</div>
        <div class="kpi-val" style="color:#10b981;">${s.my_original_posts} <span style="font-size:14px;color:var(--muted);">篇</span></div>
        <div class="kpi-sub">原创帖净赞 ${s.clean_orig_likes} · 互动回复 ${s.total_replies}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">未回关（单向关注）</div>
        <div class="kpi-val" style="color:#f43f5e;">${s.not_following_back} <span style="font-size:14px;color:var(--muted);">人</span></div>
        <div class="kpi-sub">你关注了他但他未回关</div>
      </div>
    `;
  }

  function renderCurrentView() {
    if (!auditResult) return;
    if (currentTab === "share") {
      tableToolbar.style.display = "none";
      tableContainer.style.display = "none";
      shareContainer.style.display = "block";
      renderSharePosterAndCopy();
      return;
    }

    tableToolbar.style.display = "flex";
    tableContainer.style.display = "block";
    shareContainer.style.display = "none";
    tierPills.style.display = currentTab === "unfollow" ? "none" : "flex";

    if (currentTab === "return") {
      renderReturnTable(auditResult.returnBoard);
    } else if (currentTab === "natural") {
      renderNaturalTable(auditResult.naturalBoard);
    } else if (currentTab === "unfollow") {
      renderUnfollowTable(auditResult.notFollowingBack);
    }
  }

  function filterRows(rows) {
    return rows.filter((r) => {
      if (currentTab !== "unfollow" && currentTier !== "ALL" && r.tier !== currentTier) {
        return false;
      }
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      const inAccount = (r.account || "").toLowerCase().includes(q);
      const inName = (r.name || "").toLowerCase().includes(q);
      const inSample = (r.samples || []).some((s) => (s.text || "").toLowerCase().includes(q));
      return inAccount || inName || inSample;
    });
  }

  function homeVisitHtml(r, boardType) {
    const nPosts = r.posts_touched || 0;
    const nDays = r.days_touched || 0;
    const cameOrig = Boolean(
      r.came_to_my_post ||
        r.attr_orig > 0 ||
        r.original_replies > 0 ||
        r.like > 0 ||
        r.like_visits > 0
    );
    if (nPosts >= 2 || r.browsed_home) {
      const dayTag = nDays >= 2 ? `/跨${nDays}天` : "";
      return `<span style="color:#38bdf8;font-weight:600;">✓ 翻阅主页 (${Math.max(nPosts, 2)}篇${dayTag})</span>`;
    }
    if (nPosts === 1 || cameOrig) {
      return boardType === "return"
        ? '<span style="color:#34d399;font-weight:600;" title="从外部互动通知点击头像进入你的主页并回访原帖">✓ 进主页回帖 (1篇)</span>'
        : '<span style="color:#34d399;font-weight:600;">✓ 到访主页原帖 (1篇)</span>';
    }
    return '<span style="color:var(--muted);" title="仅在外部评论串内接话，未进入你的原创帖">- 仅外部串接话</span>';
  }

  function homeVisitPosterTag(r, boardType) {
    const nPosts = r.posts_touched || 0;
    const cameOrig = Boolean(
      r.came_to_my_post ||
        r.attr_orig > 0 ||
        r.original_replies > 0 ||
        r.like > 0 ||
        r.like_visits > 0
    );
    if (nPosts >= 2 || r.browsed_home) {
      return ` · 翻阅主页(${Math.max(nPosts, 2)}篇)`;
    }
    if (nPosts === 1 || cameOrig) {
      return boardType === "return" ? " · 进主页回访" : " · 到访主页原帖";
    }
    return "";
  }

  function defaultCardDetail(r, boardType) {
    const tag = homeVisitPosterTag(r, boardType);
    if (boardType === "return") {
      return `评原帖 ${r.attr_orig} 篇 · 多轮 ${r.thread} 条 · 原帖赞 ${r.like} 篇${tag}`;
    }
    return `主动评原帖 ${r.original_replies} 篇 · 多轮 ${r.thread_replies} 条 · 赞 ${r.like_visits} 篇${tag}`;
  }

  function bindTablePosterCheckboxes(boardType) {
    tableContainer.querySelectorAll(".table-poster-chk").forEach((chk) => {
      chk.addEventListener("change", () => {
        const key = chk.getAttribute("data-key");
        const ov = userCardCustom.get(key);
        if (!ov) return;
        ov.excluded = !chk.checked;
        ov.pinned = chk.checked;
        if (chk.checked) {
          ensureUserIncludedInPosterFilter(boardType, key.split(":")[1]);
        }
        renderCurrentView();
      });
    });
  }

  function renderReturnTable(rows) {
    const list = filterRows(rows);
    const { activeReturn } = getPosterCandidates();
    const activeSet = new Set(activeReturn.map((x) => x.account));
    const html = `
      <table>
        <thead>
          <tr>
            <th style="width:46px;">排名</th>
            <th style="width:74px;">上海报</th>
            <th>账号 / 昵称</th>
            <th>档位</th>
            <th>总分</th>
            <th>受邀评原创帖 (×${pts.reply()})</th>
            <th>原帖多轮 (×${pts.thread()}递减)</th>
            <th>原创帖赞 (×${pts.like()})</th>
            <th>外部串闲聊 (×${pts.chat()})</th>
            <th>主页到访 / 翻阅深度</th>
            <th>关系与互动证据</th>
          </tr>
        </thead>
        <tbody>
          ${list
            .map((r, idx) => {
              const ov = getCardOverride("return", r);
              const inPoster = activeSet.has(r.account);
              const key = `return:${r.account}`;
              return `
            <tr style="${inPoster ? "background:rgba(16,185,129,0.06);" : ""}">
              <td style="color:var(--muted);font-weight:600;">#${idx + 1}</td>
              <td>
                <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:11.5px;color:${inPoster ? "#34d399" : "var(--muted)"};font-weight:600;">
                  <input type="checkbox" class="table-poster-chk" data-key="${escapeHtml(key)}" ${!ov.excluded && inPoster ? "checked" : ""} style="cursor:pointer;width:15px;height:15px;" />
                  ${inPoster ? "已上" : "选入"}
                </label>
              </td>
              <td>${avatarHtml(r)}</td>
              <td><span class="tier-badge tier-${r.tier}">${r.tier}</span></td>
              <td><div style="font-weight:700;font-size:15px;color:#fbbf24;">${r.score.toFixed(1)}</div>${weekBadge(r)}</td>
              <td style="font-weight:700;color:${r.attr_orig ? "#34d399" : "var(--muted)"};">${r.attr_orig} 帖</td>
              <td>${r.thread} 条</td>
              <td>${r.like} 帖</td>
              <td>${r.chat_days} 天</td>
              <td>${homeVisitHtml(r, "return")}</td>
              <td>
                <span style="font-size:12px;color:${r.mutual ? "#34d399" : "#94a3b8"};">${r.mutual ? `互关 (+${pts.mutual()})` : `单向粉我 (+${pts.follows()})`}</span>
                · <span style="font-size:12px;color:var(--muted);">${escapeHtml(r.note)}</span>
                ${(r.samples || [])
                  .slice(0, 2)
                  .map(
                    (s) =>
                      `<div class="sample-box">[${escapeHtml(s.kind)} ${(s.ts || "").slice(5, 16)}] ${escapeHtml(s.text)}</div>`
                  )
                  .join("")}
              </td>
            </tr>
          `;
            })
            .join("")}
        </tbody>
      </table>
    `;
    tableContainer.innerHTML = html;
    bindTablePosterCheckboxes("return");
  }

  function renderNaturalTable(rows) {
    const list = filterRows(rows);
    const { activeNatural } = getPosterCandidates();
    const activeSet = new Set(activeNatural.map((x) => x.account));
    const html = `
      <table>
        <thead>
          <tr>
            <th style="width:46px;">排名</th>
            <th style="width:74px;">上海报</th>
            <th>账号 / 昵称</th>
            <th>档位</th>
            <th>自来水总分</th>
            <th>主动评原创帖 (×${pts.reply()})</th>
            <th>主动多轮 (×${pts.thread()}递减)</th>
            <th>主动赞原创帖 (×${pts.like()})</th>
            <th>主页到访 / 翻阅深度</th>
            <th>关系与主动登门证据</th>
          </tr>
        </thead>
        <tbody>
          ${list
            .map((r, idx) => {
              const ov = getCardOverride("natural", r);
              const inPoster = activeSet.has(r.account);
              const key = `natural:${r.account}`;
              return `
            <tr style="${inPoster ? "background:rgba(168,85,247,0.06);" : ""}">
              <td style="color:var(--muted);font-weight:600;">#${idx + 1}</td>
              <td>
                <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:11.5px;color:${inPoster ? "#c084fc" : "var(--muted)"};font-weight:600;">
                  <input type="checkbox" class="table-poster-chk" data-key="${escapeHtml(key)}" ${!ov.excluded && inPoster ? "checked" : ""} style="cursor:pointer;width:15px;height:15px;" />
                  ${inPoster ? "已上" : "选入"}
                </label>
              </td>
              <td>${avatarHtml(r)}</td>
              <td><span class="tier-badge tier-${r.tier}">${r.tier}</span></td>
              <td><div style="font-weight:700;font-size:15px;color:#a855f7;">${r.score.toFixed(1)}</div>${weekBadge(r)}</td>
              <td style="font-weight:700;color:${r.original_replies ? "#34d399" : "var(--muted)"};">${r.original_replies} 帖</td>
              <td>${r.thread_replies} 条</td>
              <td>${r.like_visits} 帖</td>
              <td>${homeVisitHtml(r, "natural")}</td>
              <td>
                <span style="font-size:12px;color:${r.mutual ? "#34d399" : "#94a3b8"};">${r.mutual ? `互关 (+${pts.mutual()})` : `单向粉我 (+${pts.follows()})`}</span>
                · <span style="font-size:12px;color:var(--muted);">${escapeHtml(r.note)}</span>
                ${(r.samples || [])
                  .slice(0, 2)
                  .map(
                    (s) =>
                      `<div class="sample-box" style="border-left-color:#a855f7;">[${escapeHtml(s.kind)} ${(s.ts || "").slice(5, 16)}] ${escapeHtml(s.text)}</div>`
                  )
                  .join("")}
              </td>
            </tr>
          `;
            })
            .join("")}
        </tbody>
      </table>
    `;
    tableContainer.innerHTML = html;
    bindTablePosterCheckboxes("natural");
  }

  const UNFOLLOW_RENDER_LIMIT = 300;

  function renderUnfollowTable(rows) {
    const list = filterRows(rows);
    // 名单可能上千人，全部渲染会卡；只显示前 UNFOLLOW_RENDER_LIMIT 人，但要明确告诉用户
    // 还有多少人没显示（此前静默截断，真实测试里 361 人只显示 300 行且没有任何提示）。
    const hidden = Math.max(0, list.length - UNFOLLOW_RENDER_LIMIT);
    const notice = hidden
      ? `<div style="margin:10px 0;padding:8px 12px;border-radius:8px;background:rgba(244,63,94,0.10);border:1px solid rgba(244,63,94,0.35);color:#fda4af;font-size:12.5px;">
           共 ${list.length} 人，这里只显示按「我回过他的次数」排序的前 ${UNFOLLOW_RENDER_LIMIT} 人，还有 ${hidden} 人未显示。
           用上方搜索框查找具体账号，或点「📊 导出当前表 CSV」查看完整名单。
         </div>`
      : "";
    const html = `${notice}
      <table>
        <thead>
          <tr>
            <th style="width:52px;">序号</th>
            <th>未回关账号</th>
            <th>我曾主动回他</th>
            <th>对方粉丝数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${list
            .slice(0, UNFOLLOW_RENDER_LIMIT)
            .map(
              (r, idx) => `
            <tr>
              <td style="color:var(--muted);">#${idx + 1}</td>
              <td>${avatarHtml(r)}</td>
              <td style="color:${r.my_out_replies ? "#f43f5e" : "var(--muted)"};font-weight:600;">
                ${r.my_out_replies ? `我回过 ${r.my_out_replies} 次未回关` : "0 次"}
              </td>
              <td>${(r.followers || 0).toLocaleString()}</td>
              <td>
                <a class="btn" style="padding:4px 10px;font-size:12px;text-decoration:none;" href="https://x.com/${escapeHtml(r.account)}" target="_blank">去主页查看/取关 ↗</a>
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
    tableContainer.innerHTML = html;
  }

  // 异步拉取用户头像为 ImageBitmap，不污染 Canvas，加载完成后节流触发重绘
  function ensureAvatarBitmap(user) {
    const h = user.account;
    if (avatarBitmapCache.has(h)) {
      const v = avatarBitmapCache.get(h);
      return v && typeof v === "object" ? v : null;
    }
    avatarBitmapCache.set(h, "loading");
    // 只取已采集的 pbs.twimg.com 头像；没有就保持首字母兜底，不请求第三方
    const urls = [];
    if (user.avatar) urls.push(user.avatar);

    (async () => {
      for (const u of urls) {
        try {
          const resp = await fetch(u);
          if (!resp.ok) continue;
          const blob = await resp.blob();
          if (!blob.type.startsWith("image/")) continue;
          const bmp = await createImageBitmap(blob);
          avatarBitmapCache.set(h, bmp);
          schedulePosterRedraw();
          return;
        } catch (e) {}
      }
      avatarBitmapCache.set(h, "failed");
    })();
    return null;
  }

  function schedulePosterRedraw() {
    if (posterRenderTimer) return;
    posterRenderTimer = setTimeout(() => {
      posterRenderTimer = null;
      if (currentTab === "share") drawPosterCanvasAndCopyOnly();
    }, 180);
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawAvatarCircle(ctx, user, cx, cy, radius, ringColor) {
    const bmp = ensureAvatarBitmap(user);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    if (bmp) {
      ctx.drawImage(bmp, cx - radius, cy - radius, radius * 2, radius * 2);
    } else {
      // 高颜值渐变首字母头像兜底
      const g = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      g.addColorStop(0, "#1e3a8a");
      g.addColorStop(1, "#0f172a");
      ctx.fillStyle = g;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      const initial = ((user.name || user.account || "?").trim()[0] || "?").toUpperCase();
      ctx.fillStyle = "#38bdf8";
      ctx.font = `bold ${Math.round(radius * 0.95)}px 'Microsoft YaHei', sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(initial, cx, cy + 2);
    }
    ctx.restore();

    // 外圈光环
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 2, 0, Math.PI * 2);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  function getCardOverride(boardType, r) {
    const key = `${boardType}:${r.account}`;
    let ov = userCardCustom.get(key);
    if (!ov) {
      ov = {
        excluded: false,
        pinned: false,
        name: r.name || r.account,
        detail: defaultCardDetail(r, boardType),
      };
      userCardCustom.set(key, ov);
    } else if ((!ov.name || ov.name === r.account) && r.name) {
      ov.name = r.name;
    }
    return ov;
  }

  function filterByPosterTier(rows, boardType) {
    return rows.filter((x) => {
      const ov = getCardOverride(boardType, x);
      if (ov.pinned && !ov.excluded) return true; // 手动勾选的人无条件放行进候选池
      if (posterTierMode === "S") return x.tier === "S";
      if (posterTierMode === "SA") return x.tier === "S" || x.tier === "A";
      if (posterTierMode === "SAB") return x.tier === "S" || x.tier === "A" || x.tier === "B";
      return true; // "ALL"
    });
  }

  function syncPosterLimitUi(newLimit) {
    posterLimit = newLimit;
    const customInput = document.getElementById("poster-custom-limit");
    if (customInput) customInput.value = posterLimit === 999 ? "" : String(posterLimit);
    document.querySelectorAll("#poster-limit-pills .pill").forEach((p) => {
      p.classList.toggle("active", Number(p.getAttribute("data-plimit")) === posterLimit);
    });
  }

  function ensureUserIncludedInPosterFilter(boardType, account) {
    if (!auditResult) return;
    const rows = boardType === "return" ? auditResult.returnBoard : auditResult.naturalBoard;
    const cands = filterByPosterTier(rows, boardType);
    const nonExcluded = cands.filter((r) => !getCardOverride(boardType, r).excluded);
    const pos = nonExcluded.findIndex((r) => r.account === account);
    if (pos >= 0 && pos + 1 > posterLimit) {
      syncPosterLimitUi(pos + 1);
    }
  }

  function drawSingleBoardCard(ctx, r, idx, x, y, w, h, boardType) {
    const isS = r.tier === "S";
    const ov = getCardOverride(boardType, r);
    drawRoundedRect(ctx, x, y, w, h, 16);
    ctx.fillStyle = isS ? "rgba(30, 41, 59, 0.92)" : "rgba(17, 24, 39, 0.88)";
    ctx.fill();
    ctx.strokeStyle = isS
      ? "rgba(245, 158, 11, 0.65)"
      : boardType === "return"
      ? "rgba(56, 189, 248, 0.35)"
      : "rgba(168, 85, 247, 0.35)";
    ctx.lineWidth = isS ? 2.5 : 1.5;
    ctx.stroke();

    // 圆形头像
    const avRadius = 34;
    const avCx = x + 54;
    const avCy = y + h / 2;
    drawAvatarCircle(ctx, r, avCx, avCy, avRadius, isS ? "#fbbf24" : "#34d399");

    // 排名角标
    drawRoundedRect(ctx, x + 14, y + 12, 34, 22, 6);
    ctx.fillStyle = isS ? "#f59e0b" : "#334155";
    ctx.fill();
    ctx.fillStyle = isS ? "#0f172a" : "#e2e8f0";
    ctx.font = "bold 13px 'Segoe UI', sans-serif";
    ctx.fillText(`#${idx + 1}`, x + 20, y + 28);

    // 昵称 + @handle
    const textX = x + 104;
    const dispName = String(ov.name || r.name || r.account).slice(0, 16);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 22px 'Microsoft YaHei', 'Segoe UI', sans-serif";
    ctx.fillText(dispName, textX, y + 38);

    ctx.fillStyle = "#38bdf8";
    ctx.font = "bold 17px 'Segoe UI', sans-serif";
    ctx.fillText(`@${r.account}`, textX, y + 64);

    // 互动明细标签（支持用户在编辑器中自定义修改）
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "15px 'Microsoft YaHei', sans-serif";
    const detailStr = String(ov.detail != null ? ov.detail : defaultCardDetail(r, boardType)).slice(0, 44);
    ctx.fillText(detailStr, textX, y + 90);

    // 右侧档位与总分
    const rightX = x + w - 22;
    ctx.save();
    ctx.textAlign = "right";
    ctx.fillStyle = isS ? "#fbbf24" : "#34d399";
    ctx.font = "bold 26px 'Segoe UI', sans-serif";
    ctx.fillText(`${r.score.toFixed(1)} 分`, rightX, y + 44);

    ctx.fillStyle = isS ? "#fde68a" : "#6ee7b7";
    ctx.font = "bold 15px 'Microsoft YaHei', sans-serif";
    ctx.fillText(`${r.tier} 档铁粉`, rightX, y + 72);
    ctx.restore();
  }

  function renderPosterRowsEditor(candReturn, candNatural, activeReturn, activeNatural) {
    const editorEl = document.getElementById("poster-rows-editor");
    if (!editorEl) return;

    const actRetMap = new Map((activeReturn || []).map((r, idx) => [r.account, idx + 1]));
    const actNatMap = new Map((activeNatural || []).map((r, idx) => [r.account, idx + 1]));

    const groups = [];
    if (posterMode === "return" || posterMode === "both") {
      groups.push({ boardType: "return", label: "🎯 认真回访榜候选", rows: candReturn, actMap: actRetMap });
    }
    if (posterMode === "natural" || posterMode === "both") {
      groups.push({ boardType: "natural", label: "🔥 自来水真爱榜候选", rows: candNatural, actMap: actNatMap });
    }

    editorEl.innerHTML = groups
      .map((g) => {
        const rowsHtml = g.rows
          .map((r, i) => {
            const ov = getCardOverride(g.boardType, r);
            const key = `${g.boardType}:${r.account}`;
            const posterPos = g.actMap.get(r.account);
            const isShown = Boolean(posterPos);
            return `
              <div style="display:grid;grid-template-columns:108px 155px 180px 1fr;gap:8px;align-items:center;padding:5px 8px;border-bottom:1px solid rgba(51,65,85,0.45);font-size:12px;background:${isShown ? "rgba(16,185,129,0.08)" : "transparent"};border-radius:6px;">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:700;color:${isShown ? "#34d399" : "#94a3b8"};">
                  <input type="checkbox" class="poster-row-chk" data-key="${escapeHtml(key)}" ${isShown ? "checked" : ""} title="勾选即刻展示在下方海报与 @ 文案中" style="cursor:pointer;width:15px;height:15px;" />
                  <span>${isShown ? `✅ 海报#${posterPos}` : "⬜ 未上榜"}</span>
                </label>
                <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  <span class="tier-badge tier-${r.tier}" style="padding:1px 6px;font-size:11px;">${r.tier}</span>
                  <span style="color:#38bdf8;font-weight:600;margin-left:4px;" title="原榜第 ${i + 1} 名">@${escapeHtml(r.account)}</span>
                </div>
                <input type="text" class="search-input poster-row-name" data-key="${escapeHtml(key)}" value="${escapeHtml(ov.name)}" placeholder="显示昵称..." style="width:100%;padding:4px 8px;font-size:12px;" />
                <input type="text" class="search-input poster-row-detail" data-key="${escapeHtml(key)}" value="${escapeHtml(ov.detail)}" placeholder="卡片互动文案..." style="width:100%;padding:4px 8px;font-size:12px;" />
              </div>
            `;
          })
          .join("");
        return `
          <div style="margin-bottom:8px;">
            <div style="font-size:12px;font-weight:700;color:#fbbf24;margin:4px 0 6px;">${g.label}（当前档位共 ${g.rows.length} 人，已选上海报 ${g.actMap.size} 人）</div>
            ${rowsHtml || '<div style="color:var(--muted);font-size:12px;padding:6px;">当前筛选条件下暂无候选人</div>'}
          </div>
        `;
      })
      .join("");

    editorEl.querySelectorAll(".poster-row-chk").forEach((chk) => {
      chk.addEventListener("change", () => {
        const key = chk.getAttribute("data-key");
        const [bType, acc] = key.split(":");
        const ov = userCardCustom.get(key);
        if (ov) {
          ov.excluded = !chk.checked;
          ov.pinned = chk.checked;
          if (chk.checked) {
            ensureUserIncludedInPosterFilter(bType, acc);
          }
          renderSharePosterAndCopy();
        }
      });
    });

    editorEl.querySelectorAll(".poster-row-name").forEach((inp) => {
      inp.addEventListener("input", () => {
        const key = inp.getAttribute("data-key");
        const ov = userCardCustom.get(key);
        if (ov) {
          ov.name = inp.value;
          drawPosterCanvasAndCopyOnly();
        }
      });
    });

    editorEl.querySelectorAll(".poster-row-detail").forEach((inp) => {
      inp.addEventListener("input", () => {
        const key = inp.getAttribute("data-key");
        const ov = userCardCustom.get(key);
        if (ov) {
          ov.detail = inp.value;
          drawPosterCanvasAndCopyOnly();
        }
      });
    });
  }

  function getPosterCandidates() {
    if (!auditResult) {
      return { candReturn: [], candNatural: [], activeReturn: [], activeNatural: [] };
    }
    const candReturn = filterByPosterTier(auditResult.returnBoard, "return");
    const candNatural = filterByPosterTier(auditResult.naturalBoard, "natural");
    const activeReturn = candReturn
      .filter((r) => !getCardOverride("return", r).excluded)
      .slice(0, posterLimit);
    const activeNatural = candNatural
      .filter((r) => !getCardOverride("natural", r).excluded)
      .slice(0, posterLimit);
    return { candReturn, candNatural, activeReturn, activeNatural };
  }

  function renderSharePosterAndCopy(skipEditorRebuild) {
    if (!auditResult) return;
    const { candReturn, candNatural, activeReturn, activeNatural } = getPosterCandidates();
    if (!skipEditorRebuild) {
      renderPosterRowsEditor(candReturn, candNatural, activeReturn, activeNatural);
    }
    drawPosterCanvasAndCopyOnly();
  }

  // 绘制同心圆「铁粉圈圈图」（中心是你自己 + 内外圈真实圆形头像 + 连线 + 昵称标签）
  function drawConcentricCircleGraph(ctx, me, list, boxX, boxY, boxW, boxH, boardType) {
    // 1. 容器卡片底板与深空星云径向光晕
    drawRoundedRect(ctx, boxX, boxY, boxW, boxH, 24);
    ctx.fillStyle = "rgba(9, 13, 22, 0.92)";
    ctx.fill();
    ctx.strokeStyle = "rgba(56, 189, 248, 0.28)";
    ctx.lineWidth = 2;
    ctx.stroke();

    const cx = boxX + boxW / 2;
    const cy = boxY + boxH / 2 + 10;

    const glow = ctx.createRadialGradient(cx, cy, 30, cx, cy, 480);
    glow.addColorStop(0, "rgba(16, 185, 129, 0.16)");
    glow.addColorStop(0.45, "rgba(56, 189, 248, 0.07)");
    glow.addColorStop(1, "rgba(9, 13, 22, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, 480, 0, Math.PI * 2);
    ctx.fill();

    // 顶部星系框小标题
    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 20px 'Microsoft YaHei', sans-serif";
    ctx.fillText(
      `🪐 @${me} 核心铁粉同心圆「圈圈图」 · 圈内共 ${list.length} 位真铁粉围绕（越靠内圈分值越高、连线越粗）`,
      boxX + 32,
      boxY + 42
    );

    // 2. 将选中的铁粉按人数智能分配到 1~3 个同心圆轨道，确保头像与名字绝不重叠
    const indexed = list.map((r, idx) => ({ r, rank: idx + 1 }));
    let rings = [];

    if (indexed.length <= 10) {
      rings.push({ radius: 295, avR: 40, items: indexed, label: "核心铁粉圈" });
    } else if (indexed.length <= 26) {
      const sItems = indexed.filter((x) => x.r.tier === "S");
      let innerCount =
        sItems.length >= 3 && sItems.length <= 9
          ? sItems.length
          : Math.min(8, Math.ceil(indexed.length * 0.35));
      rings.push({
        radius: 215,
        avR: 35,
        items: indexed.slice(0, innerCount),
        label: "内圈 · S档核心",
      });
      rings.push({
        radius: 420,
        avR: 29,
        items: indexed.slice(innerCount),
        label: "外圈 · A档高频",
      });
    } else {
      const sItems = indexed.filter((x) => x.r.tier === "S");
      const r1Count =
        sItems.length >= 4 && sItems.length <= 9 ? sItems.length : 8;
      const rem = indexed.length - r1Count;
      const r2Count = Math.min(15, Math.ceil(rem * 0.44));
      rings.push({
        radius: 180,
        avR: 31,
        items: indexed.slice(0, r1Count),
        label: "内圈 · S档核心",
      });
      rings.push({
        radius: 325,
        avR: 26,
        items: indexed.slice(r1Count, r1Count + r2Count),
        label: "中圈 · A档主力",
      });
      rings.push({
        radius: 465,
        avR: 23,
        items: indexed.slice(r1Count + r2Count),
        label: "外圈 · 铁粉星环",
      });
    }

    // 3. 绘制虚线同心圆轨道
    ctx.save();
    rings.forEach((ring, rIdx) => {
      ctx.beginPath();
      ctx.arc(cx, cy, ring.radius, 0, Math.PI * 2);
      ctx.strokeStyle =
        rIdx === 0
          ? "rgba(22, 199, 132, 0.32)"
          : rIdx === 1
          ? "rgba(56, 189, 248, 0.24)"
          : "rgba(148, 163, 184, 0.18)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 7]);
      ctx.stroke();
    });
    ctx.restore();

    // 4. 先绘制中心向外辐射的互动连线（底层）
    rings.forEach((ring, rIdx) => {
      const n = ring.items.length;
      if (!n) return;
      // 错开内外圈起始角度，视觉更匀称
      const startDeg = rIdx === 0 ? -90 : rIdx === 1 ? -90 + 180 / n : -90;
      ring.items.forEach((item, i) => {
        const ang = ((startDeg + (360 * i) / n) * Math.PI) / 180;
        const ux = cx + ring.radius * Math.cos(ang);
        const uy = cy + ring.radius * Math.sin(ang);
        item.ux = ux;
        item.uy = uy;

        const isS = item.r.tier === "S";
        const sc = Number(item.r.score || 10);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ux, uy);
        ctx.strokeStyle = isS
          ? "rgba(22, 199, 132, 0.62)"
          : item.r.mutual
          ? "rgba(56, 189, 248, 0.42)"
          : "rgba(168, 85, 247, 0.38)";
        ctx.lineWidth = isS
          ? Math.min(3.8, 1.8 + sc * 0.03)
          : Math.min(2.4, 1.0 + sc * 0.02);
        ctx.stroke();
        ctx.restore();
      });
    });

    // 5. 绘制中心（你自己）引力源大头像
    const meMeta = (rawDb && rawDb.users && rawDb.users[me]) || {};
    // 中心节点只用库里采到的资料；没有头像就走 drawAvatarCircle 内置的首字母渐变兜底。
    // 不再写死任何具体账号的昵称或头像（换账号使用时会显示成别人）。
    const meUser = {
      account: me,
      name: meMeta.name || me,
      avatar: meMeta.avatar || "",
    };

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 58, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(22, 199, 132, 0.16)";
    ctx.fill();
    ctx.restore();

    drawAvatarCircle(ctx, meUser, cx, cy, 48, "#16C784");

    // 中心胶囊名牌（@你的账号）
    const meTagW = 148;
    const meTagH = 28;
    drawRoundedRect(ctx, cx - meTagW / 2, cy + 54, meTagW, meTagH, 14);
    ctx.fillStyle = "#064e3b";
    ctx.fill();
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#ecfdf5";
    ctx.font = "bold 15px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillText(`@${me}`, cx, cy + 73);
    ctx.restore();

    // 6. 绘制每一圈铁粉的圆形头像 + 排名角标 + 底部昵称/@handle 胶囊标签（从外圈往内圈画，内圈优先级最高）
    for (let rIdx = rings.length - 1; rIdx >= 0; rIdx--) {
      const ring = rings[rIdx];
      const avR = ring.avR;
      ring.items.forEach((item) => {
        const { r, rank, ux, uy } = item;
        const isS = r.tier === "S";
        const bType =
          boardType === "both" ? r._boardType || "return" : boardType;
        const ov = getCardOverride(bType, r);
        const ringColor = isS
          ? "#16C784"
          : r.mutual
          ? "#38bdf8"
          : "#f59e0b";

        // 头像背景遮罩圆（挡住穿过底部的连线）
        ctx.save();
        ctx.beginPath();
        ctx.arc(ux, uy, avR + 3, 0, Math.PI * 2);
        ctx.fillStyle = "#090d16";
        ctx.fill();
        ctx.restore();

        drawAvatarCircle(ctx, r, ux, uy, avR, ringColor);

        // 右上角 #排名 小徽章
        const badgeX = ux + avR * 0.72;
        const badgeY = uy - avR * 0.72;
        ctx.save();
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, 12, 0, Math.PI * 2);
        ctx.fillStyle = isS ? "#f59e0b" : "#1e293b";
        ctx.fill();
        ctx.strokeStyle = isS ? "#fde68a" : "#475569";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = isS ? "#0f172a" : "#e2e8f0";
        ctx.font = "bold 11px 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(`${rank}`, badgeX, badgeY + 0.5);
        ctx.restore();

        // 头像下方昵称 + @handle 胶囊牌
        const rawName = String(ov.name || r.name || r.account).trim();
        const shortName =
          rawName.length > 8 ? rawName.slice(0, 7) + "…" : rawName;
        const labelText = `${shortName}`;
        const subHandle = `@${r.account.slice(0, 11)}`;

        ctx.save();
        ctx.font = "bold 13px 'Microsoft YaHei', 'Segoe UI', sans-serif";
        const w1 = ctx.measureText(labelText).width;
        ctx.font = "11px 'Segoe UI', sans-serif";
        const w2 = ctx.measureText(subHandle).width;
        const pillW = Math.max(w1, w2) + 16;
        const pillH = 32;
        const pillX = ux - pillW / 2;
        const pillY = uy + avR + 5;

        drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 8);
        ctx.fillStyle = "rgba(11, 17, 32, 0.90)";
        ctx.fill();
        ctx.strokeStyle = isS
          ? "rgba(22, 199, 132, 0.55)"
          : "rgba(56, 189, 248, 0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textAlign = "center";
        ctx.fillStyle = isS ? "#fef08a" : "#f8fafc";
        ctx.font = "bold 12.5px 'Microsoft YaHei', 'Segoe UI', sans-serif";
        ctx.fillText(labelText, ux, pillY + 14);

        ctx.fillStyle = "#38bdf8";
        ctx.font = "10.5px 'Segoe UI', sans-serif";
        ctx.fillText(subHandle, ux, pillY + 27);
        ctx.restore();
      });
    }

    // 7. 左下角与右下角图例说明
    ctx.save();
    // 绿点：内圈 S 档
    ctx.beginPath();
    ctx.arc(boxX + 38, boxY + boxH - 54, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#16C784";
    ctx.fill();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "15px 'Microsoft YaHei', sans-serif";
    ctx.fillText(
      "内圈绿环：S 档核心铁粉（多次回访原创帖 · 连线越粗互动越深）",
      boxX + 52,
      boxY + boxH - 49
    );

    // 蓝点：外圈 A 档
    ctx.beginPath();
    ctx.arc(boxX + 38, boxY + boxH - 26, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#38bdf8";
    ctx.fill();
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(
      "外圈蓝环：A 档高频互访铁粉（均带真实头像、排名与昵称）",
      boxX + 52,
      boxY + boxH - 21
    );

    ctx.textAlign = "right";
    ctx.fillStyle = "#64748b";
    ctx.font = "14px 'Microsoft YaHei', sans-serif";
    ctx.fillText(
      "💡 在上方勾选/取消勾选人员或切换 S档/S+A档/前N名，圈圈图自动实时重排",
      boxX + boxW - 32,
      boxY + boxH - 24
    );
    ctx.restore();
  }

  function drawPosterCanvasAndCopyOnly() {
    if (!auditResult) return;
    const me = auditResult.me || "";
    const { activeReturn: topReturn, activeNatural: topNatural } = getPosterCandidates();

    const canvas = document.getElementById("poster-canvas");
    const ctx = canvas.getContext("2d");
    const panelTitle = document.getElementById("poster-panel-title");

    const W = 1600;
    const today = new Date().toISOString().slice(0, 10);
    const tierDesc =
      posterTierMode === "S"
        ? "S档核心"
        : posterTierMode === "SA"
        ? "S+A档"
        : posterTierMode === "SAB"
        ? "S+A+B档"
        : "全档位";

    const showCircle = posterLayout === "circle_cards" || posterLayout === "circle_only";
    const showCards = posterLayout === "circle_cards" || posterLayout === "cards_only";
    const circleBoxH = 1090;

    if (posterMode === "return" || posterMode === "natural") {
      const list = posterMode === "return" ? topReturn : topNatural;
      const isRet = posterMode === "return";
      const cols = 2;
      const rows = Math.max(1, Math.ceil(list.length / cols));
      const cardW = 736;
      const cardH = 110;
      const gapX = 32;
      const gapY = 20;

      const circleTopY = 180;
      const cardsStartY = showCircle ? circleTopY + circleBoxH + 34 : 185;
      const H =
        (showCards
          ? cardsStartY + rows * (cardH + gapY)
          : circleTopY + circleBoxH) + 95;

      canvas.width = W;
      canvas.height = H;

      const layoutTag =
        posterLayout === "circle_only"
          ? "同心圆圈圈图"
          : posterLayout === "circle_cards"
          ? "同心圆圈圈图 + 荣誉卡片"
          : "超清荣誉卡片";

      if (panelTitle) {
        panelTitle.textContent = isRet
          ? `🪐 榜一：受邀回访铁粉 ${layoutTag}（${tierDesc} · 已选 ${list.length} 人 · 1600×${H}）`
          : `🪐 榜二：自来水真爱铁粉 ${layoutTag}（${tierDesc} · 已选 ${list.length} 人 · 1600×${H}）`;
      }

      const defaultTitle = isRet
        ? `@${me} · 本周「认真回访」真铁粉同心圆与荣誉榜 (TOP ${list.length})`
        : `@${me} · 本周「主动登门」自来水真爱铁粉圈与荣誉榜 (TOP ${list.length})`;
      const defaultSub = isRet
        ? `实盘互动审计 (${today}) · 我去外部互动后 7 天内进入我主页认真回访原创主帖并评论/点赞的高价值老铁`
        : `实盘互动审计 (${today}) · 未受外部触达、主动登门评论与点赞我原创主帖的自来水真爱老铁`;
      const defaultFooter = `Powered by @${me} X-Fan 铁粉双榜审计插件 v10 · 只认原创主帖真实评论与净点赞 · 强烈推荐大家互关以上高回访创作者`;

      const titleInput = document.getElementById("poster-custom-title");
      const subInput = document.getElementById("poster-custom-sub");
      const footerInput = document.getElementById("poster-custom-footer");
      if (titleInput && !posterTextCustom.title) titleInput.placeholder = defaultTitle;
      if (subInput && !posterTextCustom.sub) subInput.placeholder = defaultSub;
      if (footerInput && !posterTextCustom.footer) footerInput.placeholder = defaultFooter;

      // 背景渐变
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, "#070b14");
      grad.addColorStop(0.5, "#0f172a");
      grad.addColorStop(1, isRet ? "#0c2e4e" : "#2e1065");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      // 顶部装饰条与大标题
      ctx.fillStyle = isRet ? "#16C784" : "#c084fc";
      ctx.fillRect(48, 38, 110, 6);

      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 40px 'Microsoft YaHei', sans-serif";
      ctx.fillText(posterTextCustom.title || defaultTitle, 48, 94);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "21px 'Microsoft YaHei', sans-serif";
      ctx.fillText(posterTextCustom.sub || defaultSub, 48, 136);

      // 绘制同心圆「圈圈图」
      if (showCircle) {
        drawConcentricCircleGraph(ctx, me, list, 48, circleTopY, W - 96, circleBoxH, posterMode);
      }

      // 绘制下方双列荣誉卡片
      if (showCards) {
        list.forEach((r, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const cx = 48 + col * (cardW + gapX);
          const cy = cardsStartY + row * (cardH + gapY);
          drawSingleBoardCard(ctx, r, idx, cx, cy, cardW, cardH, posterMode);
        });
      }

      // 底部品牌签名
      ctx.fillStyle = "#64748b";
      ctx.font = "19px 'Microsoft YaHei', sans-serif";
      ctx.fillText(posterTextCustom.footer || defaultFooter, 48, H - 36);

      // 联动发推文案（只 @ 当前勾选上榜的人！）
      const mentions = list.map((x) => `@${x.account}`).join(" ");
      document.getElementById("tweet-copy").value = isRet
        ? `用 X-Fan 铁粉审计插件盘点了近期「有来有往、认真回访」的真铁粉圈圈图与荣誉榜（我去串门后 7 天内进我主页回访原创帖评论/点赞）：\n\n` +
          `🎯 认真回访铁粉榜（${tierDesc} TOP ${list.length}）：\n${mentions}\n\n` +
          `真心感谢各位老铁的每一次高质量回访与走心交流！强烈推荐大家关注这批最讲义气的高回访真创作者 👇`
        : `用 X-Fan 铁粉审计插件盘点了近期「未受触达、主动登门」的自来水真爱铁粉圈圈图与荣誉榜（主动来我原创主帖下评论/点赞）：\n\n` +
          `🔥 自来水真爱铁粉榜（${tierDesc} TOP ${list.length}）：\n${mentions}\n\n` +
          `感谢各位老铁长期在原创帖下的主动支持与深度讨论！强烈推荐大家互关这批高质量创作者 👇`;
    } else {
      // 双榜合体全貌模式
      const maxRows = Math.max(topReturn.length, topNatural.length, 1);
      const cardW = 736;
      const cardH = 98;
      const gapY = 16;

      // 合并去重双榜人员供同心圆圈圈图展示
      const mergedMap = new Map();
      topReturn.forEach((r) => mergedMap.set(r.account, Object.assign({}, r, { _boardType: "return" })));
      topNatural.forEach((r) => {
        if (!mergedMap.has(r.account) || r.score > mergedMap.get(r.account).score) {
          mergedMap.set(r.account, Object.assign({}, r, { _boardType: "natural" }));
        }
      });
      const mergedCircleList = Array.from(mergedMap.values()).sort((a, b) => b.score - a.score);

      const circleTopY = 180;
      const headersY = showCircle ? circleTopY + circleBoxH + 46 : 198;
      const startY = headersY + 32;
      const H =
        (showCards
          ? startY + maxRows * (cardH + gapY)
          : circleTopY + circleBoxH) + 95;

      canvas.width = W;
      canvas.height = H;
      if (panelTitle) {
        panelTitle.textContent = `🏆 双榜合体圈圈图与荣誉墙（${tierDesc} · 受邀回访 ${topReturn.length} 人 + 自来水 ${topNatural.length} 人 · 1600×${H}）`;
      }

      const defaultTitle = `@${me} · X 创作者真铁粉同心圆与双榜荣誉墙`;
      const defaultSub = `基于本地实盘互动审计 (${today}) · 左榜：受邀认真回访铁粉 · 右榜：主动登门自来水真爱粉`;
      const defaultFooter = `Powered by @${me} X-Fan 铁粉双榜审计插件 v10 · 只认原创主帖真实评论与净点赞 · 远离单向白眼狼`;

      const titleInput = document.getElementById("poster-custom-title");
      const subInput = document.getElementById("poster-custom-sub");
      const footerInput = document.getElementById("poster-custom-footer");
      if (titleInput && !posterTextCustom.title) titleInput.placeholder = defaultTitle;
      if (subInput && !posterTextCustom.sub) subInput.placeholder = defaultSub;
      if (footerInput && !posterTextCustom.footer) footerInput.placeholder = defaultFooter;

      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, "#070b14");
      grad.addColorStop(0.5, "#111827");
      grad.addColorStop(1, "#1e1b4b");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(48, 38, 110, 6);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 40px 'Microsoft YaHei', sans-serif";
      ctx.fillText(posterTextCustom.title || defaultTitle, 48, 94);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "21px 'Microsoft YaHei', sans-serif";
      ctx.fillText(posterTextCustom.sub || defaultSub, 48, 136);

      if (showCircle) {
        drawConcentricCircleGraph(ctx, me, mergedCircleList, 48, circleTopY, W - 96, circleBoxH, "both");
      }

      if (showCards) {
        // 左右分栏标题
        ctx.fillStyle = "#38bdf8";
        ctx.font = "bold 26px 'Microsoft YaHei', sans-serif";
        ctx.fillText(`🎯 榜一：认真回访铁粉 TOP ${topReturn.length}（有来有往）`, 48, headersY);

        ctx.fillStyle = "#c084fc";
        ctx.font = "bold 26px 'Microsoft YaHei', sans-serif";
        ctx.fillText(`🔥 榜二：自来水真爱粉 TOP ${topNatural.length}（主动登门）`, 816, headersY);

        topReturn.forEach((r, idx) => {
          const cy = startY + idx * (cardH + gapY);
          drawSingleBoardCard(ctx, r, idx, 48, cy, cardW, cardH, "return");
        });

        topNatural.forEach((r, idx) => {
          const cy = startY + idx * (cardH + gapY);
          drawSingleBoardCard(ctx, r, idx, 816, cy, cardW, cardH, "natural");
        });
      }

      ctx.fillStyle = "#64748b";
      ctx.font = "19px 'Microsoft YaHei', sans-serif";
      ctx.fillText(posterTextCustom.footer || defaultFooter, 48, H - 36);

      const retSet = new Set(topReturn.map((x) => x.account));
      const retMentions = Array.from(retSet).map((h) => `@${h}`).join(" ");
      const natMentions = topNatural
        .filter((x) => !retSet.has(x.account))
        .map((x) => `@${x.account}`)
        .join(" ");
      document.getElementById("tweet-copy").value =
        `用 X-Fan 铁粉双榜插件跑了一遍我近期的真实互动账本（只算原创帖评论和真点赞）：\n\n` +
        `🎯 有来有往·认真回访铁粉榜：\n${retMentions}\n\n` +
        `🔥 未触达主动登门·自来水真爱榜：\n${natMentions}\n\n` +
        `感谢各位老铁长期在原创帖下的高质量交流！强烈推荐大家互关这批高回访真创作者 👇`;
    }
  }

  // 事件绑定
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentTab = btn.getAttribute("data-tab");
      renderCurrentView();
    });
  });

  document.querySelectorAll("#tier-pills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#tier-pills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      currentTier = pill.getAttribute("data-tier");
      renderCurrentView();
    });
  });

  document.querySelectorAll("#poster-layout-pills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#poster-layout-pills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      posterLayout = pill.getAttribute("data-playout") || "circle_cards";
      drawPosterCanvasAndCopyOnly();
    });
  });

  document.querySelectorAll("#poster-mode-pills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#poster-mode-pills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      posterMode = pill.getAttribute("data-pmode");
      renderSharePosterAndCopy();
    });
  });

  document.querySelectorAll("#poster-tier-pills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#poster-tier-pills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      posterTierMode = pill.getAttribute("data-ptier") || "SA";
      renderSharePosterAndCopy();
    });
  });

  const customLimitInput = document.getElementById("poster-custom-limit");
  document.querySelectorAll("#poster-limit-pills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#poster-limit-pills .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      posterLimit = Number(pill.getAttribute("data-plimit")) || 20;
      if (customLimitInput) customLimitInput.value = posterLimit === 999 ? "" : String(posterLimit);
      renderSharePosterAndCopy();
    });
  });

  if (customLimitInput) {
    customLimitInput.addEventListener("input", () => {
      const val = parseInt(customLimitInput.value, 10);
      if (!isNaN(val) && val >= 1) {
        posterLimit = val;
        document.querySelectorAll("#poster-limit-pills .pill").forEach((p) => {
          p.classList.toggle("active", Number(p.getAttribute("data-plimit")) === val);
        });
        renderSharePosterAndCopy();
      }
    });
  }

  ["title", "sub", "footer"].forEach((field) => {
    const el = document.getElementById(`poster-custom-${field}`);
    if (el) {
      el.addEventListener("input", () => {
        posterTextCustom[field] = el.value.trim();
        drawPosterCanvasAndCopyOnly();
      });
    }
  });

  const clearAllBtn = document.getElementById("btn-clear-all-poster");
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", () => {
      if (!auditResult) return;
      auditResult.returnBoard.forEach((r) => {
        const ov = getCardOverride("return", r);
        ov.excluded = true;
        ov.pinned = false;
      });
      auditResult.naturalBoard.forEach((r) => {
        const ov = getCardOverride("natural", r);
        ov.excluded = true;
        ov.pinned = false;
      });
      renderSharePosterAndCopy();
    });
  }

  const selectAllBtn = document.getElementById("btn-select-all-poster");
  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => {
      if (!auditResult) return;
      auditResult.returnBoard.forEach((r) => {
        const ov = getCardOverride("return", r);
        ov.excluded = false;
        ov.pinned = false;
      });
      auditResult.naturalBoard.forEach((r) => {
        const ov = getCardOverride("natural", r);
        ov.excluded = false;
        ov.pinned = false;
      });
      renderSharePosterAndCopy();
    });
  }

  const toggleEditorBtn = document.getElementById("btn-toggle-editor");
  if (toggleEditorBtn) {
    toggleEditorBtn.addEventListener("click", () => {
      const wrap = document.getElementById("poster-rows-editor-wrap");
      if (wrap) {
        wrap.style.display = wrap.style.display === "none" ? "block" : "none";
      }
    });
  }

  const resetCustomBtn = document.getElementById("btn-reset-poster-custom");
  if (resetCustomBtn) {
    resetCustomBtn.addEventListener("click", () => {
      posterTextCustom.title = "";
      posterTextCustom.sub = "";
      posterTextCustom.footer = "";
      ["title", "sub", "footer"].forEach((field) => {
        const el = document.getElementById(`poster-custom-${field}`);
        if (el) el.value = "";
      });
      userCardCustom.clear();
      renderSharePosterAndCopy();
    });
  }

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    renderCurrentView();
  });

  document.getElementById("btn-patrol-inc").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "XFAN_START_PATROL", mode: "incremental" });
    document.getElementById("btn-patrol-stop").style.display = "inline-flex";
    statusLine.textContent = "⚡ 已启动 90 秒每日增量巡检，请查看正在自动滚动的 X 标签页（完成后会自动刷新本页）...";
  });

  document.getElementById("btn-patrol-full").addEventListener("click", () => {
    // 全量深采会对账：翻到底后用扫到的名单替换库里的粉丝/关注名单，取关的人会被移出（可恢复）。
    // 这会改变榜单人数，所以先让用户确认，而不是一点就开始。
    const ok = confirm(
      "全量深采对账将：\n" +
        "• 依次打开 6 个页面并自动翻页，约 3～6 分钟，期间占用一个 X 标签页（请先关掉未发完的草稿）\n" +
        "• 把粉丝/关注名单翻到底，用扫到的名单替换库里的名单，已取关的人会被移出\n" +
        "• 被移出的人只是存进 lists_removed，资料和推文都保留，可以恢复\n" +
        "• 粉丝是榜一/榜二的门槛，取关的人会从榜单里消失\n\n" +
        "建议先点「📤 导出备份 JSON」备份一份。确定开始吗？"
    );
    if (!ok) return;
    chrome.runtime.sendMessage({ type: "XFAN_START_PATROL", mode: "full" });
    document.getElementById("btn-patrol-stop").style.display = "inline-flex";
    statusLine.textContent = "🔄 已启动全量深采对账，请查看正在自动滚动的 X 标签页...";
  });

  document.getElementById("btn-patrol-stop").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "XFAN_STOP_PATROL" }, () => {
      document.getElementById("btn-patrol-stop").style.display = "none";
      loadAndRender();
    });
  });

  // CSV 公式注入防护：以 = + - @ 或制表/回车开头的文本，Excel 会当公式执行。
  // 昵称、说明是对方任意填写的内容，必须加前缀 '。
  // 数字（分数、排名）不是文本，保持原样；账号 handle 受 [a-z0-9_]{1,15} 约束，
  // 链接由账号拼成，二者没有注入风险，用 safe() 明确标记后放行，保持导出格式不变。
  const safe = (s) => ({ __safe: String(s) });
  const csvCell = (v) => {
    if (v && typeof v === "object" && "__safe" in v) return `"${v.__safe.replace(/"/g, '""')}"`;
    let s = String(v ?? "");
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };

  // 触发下载并释放 Blob URL（不释放会一直占着内存直到页面关闭）
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  document.getElementById("btn-export-csv").addEventListener("click", () => {
    if (!auditResult) return;
    let headers = [];
    let csvRows = [];
    let filename = "";
    if (currentTab === "return") {
      headers = ["排名", "账号", "昵称", "档位", "总分", "受邀评原创帖", "原帖多轮", "原创帖赞", "外部串闲聊", "翻过主页", "互关", "说明", "主页链接"];
      csvRows = filterRows(auditResult.returnBoard).map((r, i) => [
        i + 1, safe("@" + r.account), r.name, r.tier, r.score, r.attr_orig, r.thread, r.like, r.chat_days, r.browsed_home ? "是" : "否", r.mutual ? "互关" : "单向粉我", r.note, safe(`https://x.com/${r.account}`)
      ]);
      filename = `return_visit_${new Date().toISOString().slice(0, 10)}.csv`;
    } else if (currentTab === "natural") {
      headers = ["排名", "账号", "昵称", "档位", "自来水总分", "主动评原创帖", "主动多轮", "主动赞原创帖", "翻过主页", "互关", "说明", "主页链接"];
      csvRows = filterRows(auditResult.naturalBoard).map((r, i) => [
        i + 1, safe("@" + r.account), r.name, r.tier, r.score, r.original_replies, r.thread_replies, r.like_visits, r.browsed_home ? "是" : "否", r.mutual ? "互关" : "单向粉我", r.note, safe(`https://x.com/${r.account}`)
      ]);
      filename = `natural_visit_${new Date().toISOString().slice(0, 10)}.csv`;
    } else {
      headers = ["序号", "未回关账号", "昵称", "我曾主动回他次数", "对方粉丝数", "认证", "主页链接"];
      csvRows = filterRows(auditResult.notFollowingBack).map((r, i) => [
        i + 1, safe("@" + r.account), r.name, r.my_out_replies, r.followers, r.verified ? "蓝V" : "", safe(`https://x.com/${r.account}`)
      ]);
      filename = `not_following_back_${new Date().toISOString().slice(0, 10)}.csv`;
    }
    const content = "\uFEFF" + [headers.map(csvCell).join(","), ...csvRows.map((row) => row.map(csvCell).join(","))].join("\r\n");
    downloadBlob(new Blob([content], { type: "text/csv;charset=utf-8" }), filename);
  });

  document.getElementById("file-import").addEventListener("change", (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        chrome.runtime.sendMessage({ type: "XFAN_IMPORT_JSON", payload: parsed }, () => {
          loadAndRender();
        });
      } catch (e) {
        alert("JSON 解析失败: " + e.message);
      }
    };
    reader.readAsText(file, "utf-8");
  });

  document.getElementById("btn-export-json").addEventListener("click", () => {
    if (!rawDb) return;
    downloadBlob(
      new Blob([JSON.stringify(rawDb)], { type: "application/json;charset=utf-8" }),
      `fan-audit-${new Date().toISOString().slice(0, 10)}.json`
    );
  });

  document.getElementById("btn-download-poster").addEventListener("click", () => {
    const canvas = document.getElementById("poster-canvas");
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    const tag = posterMode === "return" ? "return-visit" : posterMode === "natural" ? "natural-fans" : "dual-board";
    a.download = `xfan-${tag}-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  });

  const copyTweetHandler = () => {
    const box = document.getElementById("tweet-copy");
    box.select();
    navigator.clipboard.writeText(box.value);
    const btn1 = document.getElementById("btn-copy-tweet");
    const btn2 = document.getElementById("btn-copy-tweet-top");
    if (btn1) btn1.textContent = "✅ 已复制发推文案！";
    if (btn2) btn2.textContent = "✅ 已复制文案！";
    setTimeout(() => {
      if (btn1) btn1.textContent = "📋 复制发推文案";
      if (btn2) btn2.textContent = "📋 复制配套 @ 铁粉文案";
    }, 2000);
  };
  document.getElementById("btn-copy-tweet").addEventListener("click", copyTweetHandler);
  const topCopyBtn = document.getElementById("btn-copy-tweet-top");
  if (topCopyBtn) topCopyBtn.addEventListener("click", copyTweetHandler);

  document.getElementById("btn-export-recommend").addEventListener("click", () => {
    if (!auditResult) return;
    const payload = {
      schema: "xfan-public-recommend-v1",
      exported_at: new Date().toISOString(),
      recommender: auditResult.me || "",
      return_visit_SA: auditResult.returnBoard
        .filter((x) => x.tier === "S" || x.tier === "A")
        .map((x) => ({
          handle: x.account,
          name: x.name,
          avatar: x.avatar || "",
          tier: x.tier,
          score: x.score,
          orig_comments: x.attr_orig,
          orig_likes: x.like,
          browsed_home: x.browsed_home,
        })),
      natural_visit_SA: auditResult.naturalBoard
        .filter((x) => x.tier === "S" || x.tier === "A")
        .map((x) => ({
          handle: x.account,
          name: x.name,
          avatar: x.avatar || "",
          tier: x.tier,
          score: x.score,
          orig_comments: x.original_replies,
          orig_likes: x.like_visits,
          browsed_home: x.browsed_home,
        })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    downloadBlob(blob, `xfan-recommend-${payload.recommender}-${new Date().toISOString().slice(0, 10)}.json`);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "XFAN_PATROL_STATUS") return;
    const stopBtn = document.getElementById("btn-patrol-stop");
    if (stopBtn) stopBtn.style.display = msg.patrolRunning ? "inline-flex" : "none";
    if (msg.statusText) {
      statusLine.textContent = msg.statusText;
    } else {
      loadAndRender();
    }
  });

  loadAndRender();
})();
