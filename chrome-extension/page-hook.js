/**
 * X-Fan Audit - MAIN World Hook (page-hook.js)
 * 只挂钩 X 页面自己的 fetch / XHR 响应与 DOM 列表，绝不主动向 X 发任何额外请求。
 */
(function () {
  if (window.__XFAN_EXT_HOOKED__) return;
  window.__XFAN_EXT_HOOKED__ = true;

  const LEGACY_KEY = "fan_audit_collect_v1";

  function cleanHandle(h) {
    h = String(h || "").replace(/^\/+/, "").split(/[/?#]/)[0].toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(h)) return "";
    if (
      [
        "home",
        "explore",
        "notifications",
        "messages",
        "search",
        "settings",
        "i",
        "compose",
        "intent",
        "hashtag",
        "tos",
        "privacy",
      ].indexOf(h) >= 0
    ) {
      return "";
    }
    return h;
  }

  function detectMeHandle() {
    try {
      const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (link) {
        const h = cleanHandle(link.getAttribute("href"));
        if (h) return h;
      }
      const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (switcher) {
        const m = (switcher.innerText || "").match(/@([A-Za-z0-9_]{1,15})/);
        if (m && m[1]) return m[1].toLowerCase();
      }
    } catch (e) {}
    return "";
  }

  // 关注/粉丝列表对应的 GraphQL 操作名。只认这三个，避免把「推荐关注」
  // 「共同关注」(FollowersYouKnow) 等同页面的其他响应误当成名单。
  const FOLLOW_OP_RE = /\/graphql\/[^/]+\/(Followers|Following|BlueVerifiedFollowers)(?:[/?#]|$)/i;

  function listKindFromUrl(url) {
    const m = String(url || "").match(FOLLOW_OP_RE);
    if (!m) return "";
    return m[1].toLowerCase() === "following" ? "following" : "followers";
  }

  function ownerFromPath() {
    return cleanHandle((location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/) || [])[1] || "");
  }

  // 在「发出请求」那一刻记下页面上下文：响应回来时用户可能已经 SPA 跳到别的页面，
  // 用回来时的 location 判断会张冠李戴。
  function snapshotCtx() {
    return { here: currentKind(), owner: ownerFromPath() };
  }

  // 侧栏刚渲染前识别不到「我」，此时宁可等一等，也不要用页面主人顶替。
  const ME_RETRY_MS = 500;
  const ME_RETRY_MAX = 16;

  function currentKind() {
    const p = location.pathname;
    if (/\/following\/?$/i.test(p)) return "following";
    if (/\/(followers|verified_followers)\/?$/i.test(p)) return "followers";
    if (/\/with_replies\/?$/i.test(p)) return "replies";
    if (/\/search/i.test(p)) return "incoming";
    if (/\/notifications/i.test(p)) return "notifications";
    if (/^\/[A-Za-z0-9_]{1,15}\/?$/.test(p)) {
      const seg = cleanHandle(p);
      if (seg) return "posts";
    }
    return "other";
  }

  function walk(node, visit, depth) {
    const d = depth || 0;
    if (!node || d > 28 || typeof node !== "object") return;
    // visitor 显式返回 false 时剪掉整棵子树（必须 === false：§1/§2 的
    // visitor 末尾返回的是计数数字，用 falsy 判断会误剪）
    if (visit(node) === false) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], visit, d + 1);
    } else {
      for (const k in node) {
        if (k === "retweeted_status_result" || k === "quoted_status_result") continue;
        walk(node[k], visit, d + 1);
      }
    }
  }

  function extractDelta(url, data, ctx, tries) {
    ctx = ctx || snapshotCtx();
    tries = tries || 0;
    const me = detectMeHandle();
    if (!me && tries < ME_RETRY_MAX) {
      setTimeout(() => extractDelta(url, data, ctx, tries + 1), ME_RETRY_MS);
      return;
    }
    const here = ctx.here;
    const owner = ctx.owner;
    // 名单归属必须同时满足：页面主人就是我、请求确实是名单接口、页面类型与接口一致。
    // 少任何一条，浏览别人的 followers 页或同页的推荐用户都会被记成我的名单。
    const opKind = listKindFromUrl(url);
    const listTag =
      me && owner === me && opKind && (here === "following" || here === "followers") && opKind === here
        ? opKind
        : "";
    const fallbackAuthor = here === "replies" || here === "posts" ? owner : "";

    const batch = {
      me: me || "",
      lists: { following: {}, followers: {} },
      users: {},
      tweets: {},
      likes: {},
      counts: { users: 0, tweets: 0, likes: 0 },
    };

    // 1. 提取用户与关注/粉丝列表
    walk(data, (o) => {
      const legacy = o.legacy || {};
      const core = o.core || {};
      const sn = core.screen_name || legacy.screen_name || o.screen_name;
      const followers =
        legacy.followers_count != null ? legacy.followers_count : o.followers_count;
      const isUser =
        o.__typename === "User" ||
        followers !== undefined ||
        (core.screen_name && (o.rest_id || legacy.default_profile !== undefined));
      if (!sn || !isUser) return;
      if (typeof sn !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(sn)) return;
      const h = sn.toLowerCase();
      const rawAvatar =
        (o.avatar && o.avatar.image_url) ||
        legacy.profile_image_url_https ||
        o.profile_image_url_https ||
        "";
      batch.users[h] = {
        id: String(o.rest_id || o.id_str || ""),
        handle: h,
        name: core.name || legacy.name || o.name || "",
        avatar: String(rawAvatar).replace("_normal.", "_400x400."),
        followers: followers || 0,
        following:
          o.friends_count != null ? o.friends_count : legacy.friends_count || 0,
        verified: !!(o.verified || o.is_blue_verified || legacy.verified),
        created: core.created_at || o.created_at || legacy.created_at || "",
      };
      if (listTag) batch.lists[listTag][h] = 1;
      batch.counts.users++;
    });

    // 2. 提取推文（仅处理含 o.legacy 的顶层 Tweet 节点，防止 walk 进入 o.legacy 子节点时用 fallbackAuthor 覆盖真实作者）
    walk(data, (o) => {
      if (!o || !o.legacy) return;
      const legacy = o.legacy;
      const text = legacy.full_text != null ? legacy.full_text : o.full_text;
      const created = legacy.created_at || o.created_at;
      const tid = String(o.rest_id || o.id_str || legacy.id_str || "");
      if (text === undefined || !created || !tid) return;
      if (batch.tweets[tid] && batch.tweets[tid].author) return;
      let author = o.screen_name || (o.user && o.user.screen_name) || "";
      const paths = [
        ((o.core || {}).user_results || {}).result,
        (o.user_results || {}).result,
      ];
      for (let i = 0; i < paths.length; i++) {
        let node = paths[i];
        if (!node) continue;
        if (node.__typename === "UserResults" && node.result) node = node.result;
        const fromLegacy = (node.legacy || {}).screen_name;
        const fromCore = (node.core || {}).screen_name;
        if (fromLegacy) {
          author = fromLegacy;
          break;
        }
        if (fromCore) {
          author = fromCore;
          break;
        }
      }
      const isReply = !!(
        legacy.in_reply_to_status_id_str ||
        o.in_reply_to_status_id_str ||
        legacy.in_reply_to_screen_name ||
        o.in_reply_to_screen_name
      );
      if (!author) {
        if (here === "posts" && !isReply) {
          author = fallbackAuthor || "";
        } else if (here === "replies" && isReply) {
          author = fallbackAuthor || "";
        }
      }
      batch.tweets[tid] = {
        id: tid,
        author: String(author).toLowerCase(),
        text: String(text).slice(0, 400),
        created_at: created,
        reply_to_post:
          legacy.in_reply_to_status_id_str || o.in_reply_to_status_id_str || "",
        reply_to_user: String(
          legacy.in_reply_to_screen_name || o.in_reply_to_screen_name || ""
        ).toLowerCase(),
        likes:
          legacy.favorite_count != null
            ? legacy.favorite_count
            : o.favorite_count || 0,
        retweets:
          legacy.retweet_count != null
            ? legacy.retweet_count
            : o.retweet_count || 0,
        is_reply: isReply,
      };
      batch.counts.tweets++;
    });

    // 3. 提取点赞通知（v2：结构化读 from_users，存 url / likers / schema）
    //    不再递归 walk(o.template)：那会把「被赞帖的作者（我自己）」和
    //    「引用推文原作者」一起扫进来，才需要下游用黑名单去补。
    //    template.from_users 是权威路径。
    walk(data, (o) => {
      if (
        o.__typename !== "TimelineNotification" ||
        o.notification_icon !== "heart_icon"
      ) {
        return;
      }
      const nid = String(o.id || "");
      if (!nid) return;
      const ts = o.timestamp_ms || "";
      const nUrl = (o.notification_url || {}).url || "";
      const tweet = (nUrl.match(/status\/(\d+)/) || [])[1] || "";

      const tweets = [];
      const targets = (o.template && o.template.target_objects) || [];
      if (Array.isArray(targets)) {
        targets.forEach((tObj) => {
          let r = tObj && tObj.tweet_results && tObj.tweet_results.result;
          if (r && r.__typename === "TweetWithVisibilityResults" && r.tweet) {
            r = r.tweet;
          }
          const tid = r && (r.rest_id || (r.legacy && r.legacy.id_str));
          if (tid && tweets.indexOf(String(tid)) < 0) tweets.push(String(tid));
        });
      }
      if (tweet && tweets.indexOf(tweet) < 0) tweets.unshift(tweet);

      const selfHandle = me || "";
      const handles = [];
      const tmpl = o.template || {};
      const fromUsers = Array.isArray(tmpl.from_users) ? tmpl.from_users : null;

      if (fromUsers) {
        fromUsers.forEach((u) => {
          let r = u && u.user_results && u.user_results.result;
          if (r && r.__typename === "UserResults" && r.result) r = r.result;
          const sn =
            (r && r.core && r.core.screen_name) ||
            (r && r.legacy && r.legacy.screen_name) ||
            "";
          const h = String(sn).toLowerCase();
          if (!/^[a-z0-9_]{1,15}$/.test(h)) return;
          if (h === selfHandle) return;
          if (handles.indexOf(h) < 0) handles.push(h);
        });
      } else {
        // 退化路径：没有 from_users 时退回整树遍历，但剪掉 Tweet 子树
        walk(tmpl, (n) => {
          if (n && n.__typename === "Tweet") return false;
          const sn =
            (n.core && n.core.screen_name) || (n.legacy && n.legacy.screen_name);
          if (sn && /^[A-Za-z0-9_]{1,15}$/.test(sn)) {
            const h = String(sn).toLowerCase();
            if (h !== selfHandle && handles.indexOf(h) < 0) handles.push(h);
          }
        });
      }

      if (!handles.length) return;
      const schema = fromUsers ? 2 : 1;
      batch.likes[nid] = {
        ts: ts,
        url: nUrl,
        tweet: tweet || tweets[0] || "",
        tweets: tweets,
        handles: handles,
        likers: handles,
        schema: schema,
        clean_v10: schema === 2 ? 1 : 0,
      };
      handles.forEach((h) => {
        if (!batch.users[h]) {
          batch.users[h] = {
            handle: h,
            name: "",
            followers: 0,
            following: 0,
            verified: false,
            created: "",
            id: "",
          };
        }
      });
      batch.counts.likes++;
    });

    if (batch.counts.users || batch.counts.tweets || batch.counts.likes) {
      window.postMessage({ __xfan_type: "XFAN_BATCH", payload: batch }, "*");
    }
  }

  // Hook fetch
  const origFetch = window.fetch;
  window.fetch = function () {
    const req = arguments[0];
    const url = typeof req === "string" ? req : (req && req.url) || "";
    const ctx = snapshotCtx();
    const p = origFetch.apply(this, arguments);
    p.then((res) => {
      try {
        if (!/\/i\/api\/|graphql/i.test(url)) return;
        res
          .clone()
          .json()
          .then((d) => extractDelta(url, d, ctx))
          .catch(() => {});
      } catch (e) {}
    }).catch(() => {});
    return p;
  };

  // Hook XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) {
    this.__xfanUrl = url || "";
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const ctx = snapshotCtx();
    this.addEventListener("load", function () {
      try {
        const u = this.__xfanUrl || "";
        if (!/\/i\/api\/|graphql/i.test(u)) return;
        if (this.responseText && this.responseText[0] === "{") {
          extractDelta(u, JSON.parse(this.responseText), ctx);
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // 已经上报过的内容：定时扫描每 2.5 秒跑一次，页面没变化就不该重复发消息。
  // 页面刷新（含扩展重载触发的刷新）后这些缓存自然清空，会重新上报一遍。
  const sentCells = new Set();      // kind|handle|name|avatar|verified
  const sentAvatars = new Map();    // handle -> avatar
  let lastMeSent = "";

  // DOM 兜底扫描（关注/粉丝列表）
  function scanFollowDom() {
    const kind = currentKind();
    if (kind !== "following" && kind !== "followers") return;
    // 只有在「我自己的」关注/粉丝页才能把页面上的人记成我的名单
    const me = detectMeHandle();
    if (!me || ownerFromPath() !== me) return;
    // 只取主列里的用户卡片。右侧栏的「推荐关注」「你可能会喜欢」用的是同一种 UserCell，
    // 取整个文档会把它们当成名单成员记进去（实测：名单里多出 35 个从不与你互动、
    // 也没有 API 资料的账号，数量与粉丝比主页多出的 34 吻合）。
    const column = document.querySelector('[data-testid="primaryColumn"]');
    if (!column) return;
    const cells = column.querySelectorAll('[data-testid="UserCell"]');
    if (!cells.length) return;
    const batch = {
      me,
      lists: { following: {}, followers: {} },
      users: {},
      tweets: {},
      likes: {},
      counts: { users: 0, tweets: 0, likes: 0 },
    };
    cells.forEach((cell) => {
      const links = cell.querySelectorAll('a[href^="/"]');
      let handle = "";
      let name = "";
      for (let i = 0; i < links.length; i++) {
        const h = cleanHandle(links[i].getAttribute("href"));
        if (!h) continue;
        handle = h;
        const txt = (links[i].textContent || "").trim();
        if (txt && txt[0] !== "@" && !name) name = txt;
      }
      if (!handle) return;
      const imgEl = cell.querySelector('img[src*="profile_images"]');
      const avatar = imgEl ? String(imgEl.src).replace("_normal.", "_400x400.").replace("_bigger.", "_400x400.") : "";
      const verified = !!cell.querySelector('[data-testid="icon-verified"]');
      const sig = [kind, handle, name || "", avatar, verified ? 1 : 0].join("|");
      if (sentCells.has(sig)) return;
      sentCells.add(sig);
      batch.lists[kind][handle] = 1;
      batch.users[handle] = {
        handle,
        name: name || "",
        avatar,
        followers: 0,
        following: 0,
        verified,
        created: "",
        id: "",
      };
      batch.counts.users++;
    });
    if (batch.counts.users > 0) {
      window.postMessage({ __xfan_type: "XFAN_BATCH", payload: batch }, "*");
    }
  }

  // 扫描任意 X 页面上的用户头像（通知页/回复页/主帖页），补齐头像库
  function scanAvatarsDom() {
    const imgs = document.querySelectorAll('img[src*="pbs.twimg.com/profile_images/"]');
    if (!imgs.length) return;
    const batch = {
      me: detectMeHandle(),
      lists: { following: {}, followers: {} },
      users: {},
      tweets: {},
      likes: {},
      counts: { users: 0, tweets: 0, likes: 0 },
    };
    imgs.forEach((img) => {
      let handle = "";
      const container = img.closest('[data-testid^="UserAvatar-Container-"]');
      if (container) {
        const dt = container.getAttribute("data-testid") || "";
        handle = cleanHandle(dt.replace("UserAvatar-Container-", ""));
      }
      if (!handle) {
        const link = img.closest('a[href^="/"]');
        if (link) handle = cleanHandle(link.getAttribute("href"));
      }
      if (!handle) return;
      const hd = String(img.src || "")
        .replace("_normal.", "_400x400.")
        .replace("_bigger.", "_400x400.")
        .replace("_mini.", "_400x400.");
      if (hd && sentAvatars.get(handle) !== hd) {
        sentAvatars.set(handle, hd);
        batch.users[handle] = { handle, avatar: hd };
        batch.counts.users++;
      }
    });
    if (batch.counts.users > 0) {
      window.postMessage({ __xfan_type: "XFAN_BATCH", payload: batch }, "*");
    }
  }

  // 自己账号的粉丝/关注总数只出现在页面 SSR 的 __INITIAL_STATE__ 里，网络响应里没有这两个字段。
  // 不读它，库里 users[me].followers/following 就永远是 0，
  // 对账的第 4 道保护闸（「本轮看到的人不到主页总数的 90%」）拿不到 expected，永远不生效。
  let lastProfileSig = "";
  let cachedInitialState = null;
  let scriptScanTries = 0;

  // 从 start 开始按大括号配对截出一段 JSON（跳过字符串里的括号与转义）
  function sliceBalancedJson(s, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { inStr = false; continue; }
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") { depth++; continue; }
      if (c === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return "";
  }

  // X 在 hydration 之后可能把 window.__INITIAL_STATE__ 删掉，但内联 <script> 节点还在 DOM 里。
  // 所以先读变量，读不到就退回解析脚本文本；成功后缓存，不再重复扫。
  function readInitialState() {
    try {
      if (window.__INITIAL_STATE__) return window.__INITIAL_STATE__;
    } catch (e) {}
    if (cachedInitialState) return cachedInitialState;
    if (scriptScanTries >= 5) return null;
    scriptScanTries++;
    try {
      const scripts = document.querySelectorAll("script");
      for (let i = 0; i < scripts.length; i++) {
        const t = scripts[i].textContent || "";
        const at = t.indexOf("__INITIAL_STATE__");
        if (at < 0) continue;
        const start = t.indexOf("{", at);
        if (start < 0) continue;
        const jsonText = sliceBalancedJson(t, start);
        if (!jsonText) continue;
        cachedInitialState = JSON.parse(jsonText);
        return cachedInitialState;
      }
    } catch (e) {}
    return null;
  }

  function scanInitialState() {
    try {
      const st = readInitialState();
      const ents = st && st.entities && st.entities.users && st.entities.users.entities;
      if (!ents) return false;
      const me = detectMeHandle();
      if (!me) return false;
      let hit = null;
      Object.keys(ents).forEach((key) => {
        const u = ents[key];
        if (u && String(u.screen_name || "").toLowerCase() === me) hit = { key, u };
      });
      if (!hit) return false;
      const u = hit.u;
      const legacy = u.legacy || {};
      const followers = Number(
        legacy.followers_count != null ? legacy.followers_count : u.followers_count
      );
      // 注意：u.following 是「我有没有关注他」的布尔值，不是关注数；关注数只有 friends_count。
      const following = Number(u.friends_count != null ? u.friends_count : legacy.friends_count);
      if (!(followers > 0) && !(following > 0)) return true;

      // 同一组数字只报一次：定时扫描每 2.5 秒跑一次，不能每次都发一遍。
      const sig = me + "|" + followers + "|" + following;
      if (sig === lastProfileSig) return true;
      lastProfileSig = sig;

      const batch = {
        me,
        lists: { following: {}, followers: {} },
        users: {},
        tweets: {},
        likes: {},
        counts: { users: 1, tweets: 0, likes: 0 },
      };
      batch.users[me] = {
        id: String(u.id_str || hit.key || ""),
        handle: me,
        name: u.name || (u.core && u.core.name) || "",
        avatar: String(u.profile_image_url_https || "").replace("_normal.", "_400x400."),
        followers: followers > 0 ? followers : 0,
        following: following > 0 ? following : 0,
        verified: !!(u.is_blue_verified || u.verified),
        created: u.created_at || "",
      };
      window.postMessage({ __xfan_type: "XFAN_BATCH", payload: batch }, "*");
      return true;
    } catch (e) {
      return false;
    }
  }

  // 启动时自动把旧版 localStorage["fan_audit_collect_v1"] 迁移进插件无限存储。
  // 迁移成功（后台确认）后记下内容签名，内容没变就不再重复迁移；旧数据本身不删除。
  const MIGRATED_KEY = "fan_audit_collect_v1_migrated_sig";

  function contentSig(s) {
    // djb2：只是判断「内容变没变」，不需要密码学强度
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ":" + (h >>> 0).toString(36);
  }

  function migrateLegacyLocalStorage() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (raw && raw[0] === "{") {
        const sig = contentSig(raw);
        if (localStorage.getItem(MIGRATED_KEY) === sig) return;
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.tweets || parsed.users)) {
          window.postMessage(
            {
              __xfan_type: "XFAN_MIGRATE_LEGACY",
              payload: {
                me: detectMeHandle() || "",
                lists: parsed.lists || { following: {}, followers: {} },
                users: parsed.users || {},
                tweets: parsed.tweets || {},
                likes: parsed.likes || {},
              },
              sig,
            },
            "*"
          );
        }
      }
    } catch (e) {}
  }

  // 后台确认写入成功后，content-bridge 会回传 ACK；这时才记下签名
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__xfan_type !== "XFAN_MIGRATE_ACK") return;
    try {
      if (typeof ev.data.sig === "string" && ev.data.sig) {
        localStorage.setItem(MIGRATED_KEY, ev.data.sig);
      }
    } catch (e) {}
  });

  window.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      migrateLegacyLocalStorage();
      scanInitialState();
    }, 1200);
    setInterval(() => {
      scanFollowDom();
      scanAvatarsDom();
      scanInitialState();
      const me = detectMeHandle();
      if (me && me !== lastMeSent) {
        lastMeSent = me;
        window.postMessage({ __xfan_type: "XFAN_ME_HANDLE", payload: me }, "*");
      }
    }, 2500);
  });
})();
