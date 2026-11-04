/**
 * X-Fan Audit v10 核心算分引擎（纯 JS 单源实现，与 Python fan_json_to_data.py + return_visit.py 100% 逐位对齐）
 * 同时支持浏览器 (window.XFanScorer) 与 Node.js (module.exports)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.XFanScorer = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_CFG = {
    window_days: 7,
    base: { follows_me: 5.0, mutual: 3.0 },
    combo: {
      original_reply: 40.0,
      thread_reply: 12.0,
      original_like: 4.0,
      chat_day: 1.0,
    },
    thread_decay: 0.68,
    tiers: { S: 70.0, A: 40.0, B: 15.0 },
    known_qt_authors: ["elonmusk", "thsottiaux", "wenbuilds", "bourneliu66", "morefree10086"],
    week_tz_offset_hours: 8,
  };

  const KIND_NOTE = {
    attr_original: "他回到我原创帖",
    nat_original: "他主动评论我原创帖",
    thread_only: "我原帖下多轮接话",
    like_only: "只给我原创帖点赞",
    chat_only: "只在别人串里接话",
  };

  function norm(handle) {
    return String(handle || "").trim().replace(/^@+/, "").trim().toLowerCase();
  }

  function toIso(createdAt) {
    if (!createdAt) return "";
    const s = String(createdAt).trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
    if (/^\d{10,13}$/.test(s)) {
      const ms = s.length === 10 ? Number(s) * 1000 : Number(s);
      const d = new Date(ms);
      return isNaN(d.getTime()) ? "" : d.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return d.toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    return "";
  }

  function parseDateMs(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    const t = d.getTime();
    return isNaN(t) ? null : t;
  }

  function utcDateKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function tierOf(score, tiers) {
    if (score >= tiers.S) return "S";
    if (score >= tiers.A) return "A";
    if (score >= tiers.B) return "B";
    return "C";
  }

  /**
   * 从采集库 db 直接计算双榜 + 互关/未回关白眼狼 + 互动证据明细
   * @param {Object} db - { lists: {following, followers}, users: {}, tweets: {}, likes: {} }
   * @param {string} meHandle - 当前登录用户名（不带 @）
   */
  function auditFromRawDb(db, meHandle, cfgOverride) {
    const me = norm(meHandle || (db && db.me) || "");
    const cfg = Object.assign({}, DEFAULT_CFG, cfgOverride || {});
    const lists = (db && db.lists) || {};
    const followingSet = new Set();
    const followersSet = new Set();

    Object.keys(lists.following || {}).forEach((k) => {
      const h = norm(k);
      if (h) followingSet.add(h);
    });
    Object.keys(lists.followers || {}).forEach((k) => {
      const h = norm(k);
      if (h) followersSet.add(h);
    });

    const profiles = {};
    Object.entries((db && db.users) || {}).forEach(([k, v]) => {
      const h = norm(k);
      if (h) profiles[h] = v || {};
    });

    // 深拷贝 tweets 的必要字段，避免污染原对象
    const tweets = {};
    Object.entries((db && db.tweets) || {}).forEach(([tid, t]) => {
      if (!t) return;
      tweets[tid] = Object.assign({}, t);
    });

    // 1. 补全空作者：父帖作者不是我 → 说明是我回别人
    Object.values(tweets).forEach((t) => {
      if (!norm(t.author)) {
        const pa = norm(t.reply_to_user);
        if (pa && pa !== me && me) {
          t.author = me;
        }
      }
    });

    // 1b. 用子回复的 reply_to_user 反向校准父帖真实作者（防止父帖被 fallbackAuthor 误标为 me）
    Object.values(tweets).forEach((t) => {
      const pid = t.reply_to_post;
      const ru = norm(t.reply_to_user);
      if (pid && ru && tweets[pid] && !tweets[pid].is_reply) {
        tweets[pid].author = ru;
      }
    });

    // 2. 我的原创帖集合：作者是我且本身不是回复
    const myOriginal = new Set();
    Object.entries(tweets).forEach(([tid, t]) => {
      if (me && norm(t.author) === me && !t.is_reply) {
        myOriginal.add(tid);
      }
    });

    function rootOf(tid, depth) {
      const d = depth || 0;
      if (d > 12) return ["", "broken"];
      const t = tweets[tid];
      if (!t) return ["", "broken"];
      const parent = t.reply_to_post || "";
      if (!parent) return [tid, "root"];
      if (myOriginal.has(parent)) return [parent, "in_orig"];
      if (tweets[parent]) return rootOf(parent, d + 1);
      return ["", "broken"];
    }

    function rootKindOf(tid, parentId) {
      if (myOriginal.has(parentId)) {
        return ["my_original", parentId];
      }
      const [root, state] = rootOf(tid, 0);
      if (root && myOriginal.has(root)) {
        return ["my_original_deep", root];
      }
      return [state === "broken" || !root ? "unknown" : "other", root || ""];
    }

    function rootCreated(tid) {
      const t = tweets[tid] || {};
      return toIso(t.created_at);
    }

    // 3. 构建去重后的 replies 列表
    const seenTweets = new Set();
    const replyRows = [];
    Object.entries(tweets).forEach(([tid, t]) => {
      if (seenTweets.has(tid)) return;
      const author = norm(t.author);
      const parentAuthor = norm(t.reply_to_user);
      const parentId = t.reply_to_post || "";
      if (!parentId && !parentAuthor) return;
      const created = toIso(t.created_at);
      const kind = myOriginal.has(parentId) ? "my_original" : parentId ? "my_reply" : "";
      const [rkind, rootId] = rootKindOf(tid, parentId);
      const rcreated = rkind === "my_original" || rkind === "my_original_deep" ? rootCreated(rootId) : "";

      if (me && author === me && parentAuthor) {
        seenTweets.add(tid);
        replyRows.push({
          tweet_id: tid,
          created_at: created,
          direction: "out",
          account: parentAuthor,
          text: String(t.text || "").slice(0, 300),
          in_reply_to_status_id: parentId,
          conversation_id: rootId,
          parent_kind: kind,
          root_kind: rkind,
          root_created_at: rcreated,
        });
      } else if (me && author && author !== me && parentAuthor === me) {
        seenTweets.add(tid);
        replyRows.push({
          tweet_id: tid,
          created_at: created,
          direction: "in",
          account: author,
          text: String(t.text || "").slice(0, 300),
          in_reply_to_status_id: parentId,
          conversation_id: rootId,
          parent_kind: kind,
          root_kind: rkind,
          root_created_at: rcreated,
        });
      }
    });

    // 4. 构建原创帖点赞列表
    //    新旧格式用一个开关区分：schema>=2 由采集器结构化产出（likers 来自
    //    template.from_users），直接信任；只有老数据才走 quoted_authors /
    //    known_qt_authors 启发式。按 (account, post_id) 去重取最早观察时间。
    const blobLikes = (db && db.likes) || {};
    const knownQtAuthors = new Set((cfg.known_qt_authors || DEFAULT_CFG.known_qt_authors).map(norm));
    const tailCounts = {};
    const postNotifCounts = {};

    const isV2 = (ev) => Number((ev && ev.schema) || 0) >= 2;
    const needLegacy = (ev) => !isV2(ev) && !(ev && ev.clean_v10);
    const tidsOf = (ev) => {
      if (ev.tweets && ev.tweets.length) return ev.tweets.map(String);
      const m = String(ev.url || "").match(/status\/(\d+)/);
      if (m) return [m[1]];
      return ev.tweet ? [String(ev.tweet)] : [];
    };
    const likersOf = (ev) => {
      const src = isV2(ev) && Array.isArray(ev.likers) && ev.likers.length ? ev.likers : ev.handles;
      return (src || []).map(norm).filter((h) => h && h !== me);
    };

    Object.values(blobLikes).forEach((ev) => {
      if (!ev || !needLegacy(ev)) return;
      const tids = tidsOf(ev);
      const hs = (ev.handles || []).map(norm).filter((h) => h && h !== me);
      tids.forEach((tw) => {
        if (myOriginal.has(tw) && hs.length >= 2) {
          postNotifCounts[tw] = (postNotifCounts[tw] || 0) + 1;
          const tailKey = tw + "|" + hs[hs.length - 1];
          tailCounts[tailKey] = (tailCounts[tailKey] || 0) + 1;
        }
      });
    });

    const quotedAuthors = new Set();
    Object.entries(tailCounts).forEach(([key, count]) => {
      const [tw, h] = key.split("|");
      if (count >= 2 && count === postNotifCounts[tw] && !followersSet.has(h)) {
        quotedAuthors.add(key);
      }
    });

    const likeSeen = new Map();
    Object.values(blobLikes).forEach((ev) => {
      if (!ev) return;
      const ts = ev.ts || "";
      const tids = tidsOf(ev);
      const observed = toIso(ts);
      const rawHandles = likersOf(ev);

      tids.forEach((tw) => {
        if (!myOriginal.has(tw)) return;
        const posted = toIso((tweets[tw] && tweets[tw].created_at) || "");
        let hs = rawHandles.slice();
        if (needLegacy(ev) && hs.length >= 2) {
          const tail = hs[hs.length - 1];
          if (quotedAuthors.has(tw + "|" + tail) || (knownQtAuthors.has(tail) && !followersSet.has(tail))) {
            hs = hs.slice(0, -1);
          }
        }
        hs.forEach((h) => {
          const key = h + "|" + tw;
          const prev = likeSeen.get(key);
          if (!prev || (observed && observed < prev.first_observed_at)) {
            likeSeen.set(key, {
              account: h,
              post_id: tw,
              direction: "in",
              post_created_at: posted,
              first_observed_at: observed,
              observed_baseline: false,
            });
          }
        });
      });
    });

    const likeRows = Array.from(likeSeen.values()).sort((a, b) => {
      if (a.first_observed_at !== b.first_observed_at) return a.first_observed_at < b.first_observed_at ? -1 : 1;
      if (a.account !== b.account) return a.account < b.account ? -1 : 1;
      return a.post_id < b.post_id ? -1 : 1;
    });

    // 5. 收集事件并按 return_visit.py v10 规则计算双榜
    const windowMs = cfg.window_days * 86400 * 1000;

    const triggers = {};      // account -> [ms]
    const origEvents = {};    // account -> [{ms, pid, text, tweet_id}]
    const threadEvents = {};  // account -> [{ms, root, text, tweet_id}]
    const chatTimes = {};     // account -> [ms]
    const likeEvents = {};    // account -> [{ms, lid}]
    const postDays = {};      // account -> { pid: "YYYY-MM-DD" }

    function ensureArr(map, k) {
      if (!map[k]) map[k] = [];
      return map[k];
    }

    replyRows.forEach((r) => {
      const account = r.account;
      if (!account) return;
      const ms = parseDateMs(r.created_at);
      if (r.direction === "out") {
        if (r.root_kind === "my_original" || r.root_kind === "my_original_deep") {
          return; // 主场礼貌接话不算外部主动出击触发点
        }
        if (ms !== null) ensureArr(triggers, account).push(ms);
      } else if (r.direction === "in") {
        if (r.parent_kind === "my_original") {
          if (ms !== null) {
            const pid = r.conversation_id || r.in_reply_to_status_id || r.tweet_id || "?";
            ensureArr(origEvents, account).push({ ms, pid, text: r.text, tweet_id: r.tweet_id });
            const postedMs = parseDateMs(r.root_created_at);
            if (postedMs !== null) {
              if (!postDays[account]) postDays[account] = {};
              postDays[account][pid] = utcDateKey(postedMs);
            }
          }
        } else if (r.root_kind === "my_original_deep") {
          if (ms !== null) {
            const pid = r.conversation_id || "?";
            ensureArr(threadEvents, account).push({ ms, root: pid, text: r.text, tweet_id: r.tweet_id });
            const postedMs = parseDateMs(r.root_created_at);
            if (postedMs !== null) {
              if (!postDays[account]) postDays[account] = {};
              postDays[account][pid] = utcDateKey(postedMs);
            }
          }
        } else if (ms !== null) {
          ensureArr(chatTimes, account).push(ms);
        }
      }
    });

    likeRows.forEach((r) => {
      if (r.observed_baseline) return;
      const account = r.account;
      const lid = r.post_id;
      const ms = parseDateMs(r.first_observed_at);
      if (account && lid && ms !== null) {
        ensureArr(likeEvents, account).push({ ms, lid });
        const postedMs = parseDateMs(r.post_created_at);
        if (postedMs !== null) {
          if (!postDays[account]) postDays[account] = {};
          postDays[account][lid] = utcDateKey(postedMs);
        }
      }
    });

    function isTriggered(account, t2Ms) {
      const tList = triggers[account] || [];
      for (let i = 0; i < tList.length; i++) {
        const t1 = tList[i];
        if (t1 <= t2Ms && t2Ms <= t1 + windowMs) return true;
      }
      return false;
    }

    const EDGE_MS = 3600000;
    function nearEdge(account, t2Ms) {
      const tList = triggers[account] || [];
      for (let i = 0; i < tList.length; i++) {
        const t1 = tList[i];
        if (t1 <= t2Ms && t2Ms <= t1 + windowMs) {
          if (t2Ms - t1 < EDGE_MS || t1 + windowMs - t2Ms < EDGE_MS) return true;
        } else if (t1 + windowMs <= t2Ms && t2Ms < t1 + windowMs + EDGE_MS) {
          return true;
        }
      }
      return false;
    }

    // 本周起点：自然周周一 00:00，按 tz_offset 换算成 UTC。
    // 与 Python 侧一致：用数据里最晚的事件时间当"现在"，保证同一份数据可复现。
    let latestMs = 0;
    const bumpMax = (v) => {
      const m = Array.isArray(v) ? v[0] : v && typeof v === "object" ? v.ms : v;
      if (m && m > latestMs) latestMs = m;
    };
    [triggers, origEvents, threadEvents, chatTimes, likeEvents].forEach((bag) => {
      Object.values(bag || {}).forEach((arr) => (arr || []).forEach(bumpMax));
    });
    const tzOffsetMs = (Number(cfg.week_tz_offset_hours) || 0) * 3600000;
    let weekStartMs = 0;
    if (latestMs) {
      const d = new Date(latestMs + tzOffsetMs);
      const dow = (d.getUTCDay() + 6) % 7;   // 周一 = 0
      d.setUTCDate(d.getUTCDate() - dow);
      d.setUTCHours(0, 0, 0, 0);
      weekStartMs = d.getTime() - tzOffsetMs;
    }
    const inWeek = (ms) => weekStartMs > 0 && ms >= weekStartMs;

    const allAccounts = new Set([
      ...followersSet,
      ...Object.keys(origEvents),
      ...Object.keys(threadEvents),
      ...Object.keys(chatTimes),
      ...Object.keys(likeEvents),
    ]);

    const returnBoard = [];
    const naturalBoard = [];

    allAccounts.forEach((account) => {
      if (followersSet.size > 0 && !followersSet.has(account)) return;

      const attrPosts = new Set();
      const naturalPosts = new Set();
      const weekPosts = new Set();
      const weekNatPosts = new Set();
      const userSamples = [];

      (origEvents[account] || []).forEach((ev) => {
        if (isTriggered(account, ev.ms)) {
          attrPosts.add(ev.pid);
          if (inWeek(ev.ms)) weekPosts.add(ev.pid);
          userSamples.push({ board: "return", kind: "评论原创帖", ts: toIso(ev.ms), text: ev.text, pid: ev.pid });
        } else {
          naturalPosts.add(ev.pid);
          if (inWeek(ev.ms)) weekNatPosts.add(ev.pid);
          userSamples.push({ board: "natural", kind: "主动评原创帖", ts: toIso(ev.ms), text: ev.text, pid: ev.pid });
        }
      });

      const sortedThreads = (threadEvents[account] || []).slice().sort((a, b) => {
        if (a.ms !== b.ms) return a.ms - b.ms;
        return a.root < b.root ? -1 : a.root > b.root ? 1 : 0;
      });

      const attrThreads = [];
      const attrThreadMs = [];
      const natThreads = [];
      const natThreadMs = [];
      sortedThreads.forEach((ev) => {
        if (isTriggered(account, ev.ms)) {
          attrThreads.push(ev.root);
          attrThreadMs.push(ev.ms);
          userSamples.push({ board: "return", kind: "原帖多轮追评", ts: toIso(ev.ms), text: ev.text, pid: ev.root });
        } else {
          natThreads.push(ev.root);
          natThreadMs.push(ev.ms);
          userSamples.push({ board: "natural", kind: "主动原帖多轮", ts: toIso(ev.ms), text: ev.text, pid: ev.root });
        }
      });

      let attrThreadPts = 0.0;
      let weekThreadPts = 0.0;
      let weekThreads = 0;
      const perRootAttr = {};
      attrThreads.forEach((root, i) => {
        const idx = perRootAttr[root] || 0;
        const points = cfg.combo.thread_reply * Math.pow(cfg.thread_decay, idx);
        attrThreadPts += points;
        perRootAttr[root] = idx + 1;
        if (inWeek(attrThreadMs[i])) {
          weekThreadPts += points;
          weekThreads += 1;
        }
      });

      let natThreadPts = 0.0;
      let weekNatThreadPts = 0.0;
      let weekNatThreads = 0;
      const perRootNat = {};
      natThreads.forEach((root, i) => {
        const idx = perRootNat[root] || 0;
        const points = cfg.combo.thread_reply * Math.pow(cfg.thread_decay, idx);
        natThreadPts += points;
        perRootNat[root] = idx + 1;
        if (inWeek(natThreadMs[i])) {
          weekNatThreadPts += points;
          weekNatThreads += 1;
        }
      });

      const daysSet = new Set();
      const weekDays = new Set();
      (chatTimes[account] || []).forEach((ms) => {
        if (isTriggered(account, ms)) {
          daysSet.add(utcDateKey(ms));
          if (inWeek(ms)) weekDays.add(utcDateKey(ms));
        }
      });

      const attrLikes = new Set();
      const naturalLikes = new Set();
      const weekAttrLikes = new Set();
      const weekNatLikes = new Set();
      (likeEvents[account] || []).forEach((ev) => {
        if (isTriggered(account, ev.ms)) {
          attrLikes.add(ev.lid);
          if (inWeek(ev.ms)) weekAttrLikes.add(ev.lid);
        } else {
          naturalLikes.add(ev.lid);
          if (inWeek(ev.ms)) weekNatLikes.add(ev.lid);
        }
      });
      const possible = (likeEvents[account] || []).some((ev) => nearEdge(account, ev.ms));

      const mutual = followingSet.has(account);
      const base = cfg.base.follows_me + (mutual ? cfg.base.mutual : 0.0);
      const touched = postDays[account] || {};
      const daysTouched = new Set(Object.values(touched)).size;
      const browsedHome = daysTouched >= 2;
      const cameToMyPost = Boolean(
        attrPosts.size || naturalPosts.size || attrThreads.length || natThreads.length
      );
      const prof = profiles[account] || {};

      // --- 结算榜一：受邀回访榜 ---
      const nAttrLike = attrLikes.size;
      const nAttrThread = attrThreads.length;
      if (attrPosts.size || daysSet.size || nAttrLike || nAttrThread) {
        const pts =
          attrPosts.size * cfg.combo.original_reply +
          nAttrLike * cfg.combo.original_like +
          daysSet.size * cfg.combo.chat_day +
          attrThreadPts;
        const total = base + pts;
        const weekPts =
          weekPosts.size * cfg.combo.original_reply +
          weekAttrLikes.size * cfg.combo.original_like +
          weekDays.size * cfg.combo.chat_day +
          weekThreadPts;
        const weekVisits = weekPosts.size + weekAttrLikes.size + weekDays.size + weekThreads;
        const kind = attrPosts.size
          ? "attr_original"
          : nAttrThread
          ? "thread_only"
          : nAttrLike
          ? "like_only"
          : "chat_only";
        const rawTier = tierOf(total, cfg.tiers);
        const tier = (rawTier === "S" || rawTier === "A") && !(cameToMyPost || browsedHome) ? "B" : rawTier;

        returnBoard.push({
          account,
          name: prof.name || "",
          avatar: prof.avatar || "",
          followers: prof.followers || 0,
          verified: Boolean(prof.verified),
          score: Number(total.toFixed(1)),
          tier,
          tier_raw: rawTier,
          kind,
          note: KIND_NOTE[kind] || kind,
          visits: attrPosts.size + nAttrLike + daysSet.size + nAttrThread,
          attr_orig: attrPosts.size,
          thread: nAttrThread,
          natural_thread: natThreads.length,
          natural_orig: naturalPosts.size,
          like: nAttrLike,
          natural_like: naturalLikes.size,
          chat_days: daysSet.size,
          posts_touched: Object.keys(touched).length,
          days_touched: daysTouched,
          browsed_home: browsedHome,
          came_to_my_post: cameToMyPost,
          confidence: possible ? "possible" : "right",
          week_earned: Number(weekPts.toFixed(1)),
          week_visits: weekVisits,
          mutual,
          base: Number(base.toFixed(1)),
          earned: Number(pts.toFixed(1)),
          samples: userSamples.filter((s) => s.board === "return").slice(0, 6),
        });
      }

      // --- 结算榜二：自来水铁粉榜 ---
      const nNatOrig = naturalPosts.size;
      const nNatThread = natThreads.length;
      const nNatLike = naturalLikes.size;
      if (nNatOrig || nNatThread || nNatLike) {
        const pts =
          nNatOrig * cfg.combo.original_reply +
          nNatLike * cfg.combo.original_like +
          natThreadPts;
        const total = base + pts;
        const weekPts =
          weekNatPosts.size * cfg.combo.original_reply +
          weekNatLikes.size * cfg.combo.original_like +
          weekNatThreadPts;
        const weekVisits = weekNatPosts.size + weekNatLikes.size + weekNatThreads;
        const kind = nNatOrig ? "nat_original" : nNatThread ? "thread_only" : "like_only";
        const rawTier = tierOf(total, cfg.tiers);
        const tier = (rawTier === "S" || rawTier === "A") && !(cameToMyPost || browsedHome) ? "B" : rawTier;

        naturalBoard.push({
          account,
          name: prof.name || "",
          avatar: prof.avatar || "",
          followers: prof.followers || 0,
          verified: Boolean(prof.verified),
          score: Number(total.toFixed(1)),
          tier,
          tier_raw: rawTier,
          kind,
          note: KIND_NOTE[kind] || kind,
          visits: nNatOrig + nNatThread + nNatLike,
          original_replies: nNatOrig,
          thread_replies: nNatThread,
          like_visits: nNatLike,
          posts_touched: Object.keys(touched).length,
          days_touched: daysTouched,
          browsed_home: browsedHome,
          came_to_my_post: cameToMyPost,
          confidence: possible ? "possible" : "right",
          week_earned: Number(weekPts.toFixed(1)),
          week_visits: weekVisits,
          mutual,
          base: Number(base.toFixed(1)),
          earned: Number(pts.toFixed(1)),
          samples: userSamples.filter((s) => s.board === "natural").slice(0, 6),
        });
      }
    });

    returnBoard.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.attr_orig !== a.attr_orig) return b.attr_orig - a.attr_orig;
      if (b.visits !== a.visits) return b.visits - a.visits;
      return a.account < b.account ? -1 : 1;
    });

    naturalBoard.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.original_replies !== a.original_replies) return b.original_replies - a.original_replies;
      if (b.visits !== a.visits) return b.visits - a.visits;
      return a.account < b.account ? -1 : 1;
    });

    // 6. 计算互关与「未回关（白眼狼）」列表
    const mutualCount = Array.from(followingSet).filter((h) => followersSet.has(h)).length;
    const notFollowingBack = [];
    followingSet.forEach((h) => {
      if (!followersSet.has(h)) {
        const p = profiles[h] || {};
        const myOutCount = (triggers[h] || []).length;
        notFollowingBack.push({
          account: h,
          name: p.name || "",
          avatar: p.avatar || "",
          followers: p.followers || 0,
          following: p.following || 0,
          verified: Boolean(p.verified),
          my_out_replies: myOutCount,
        });
      }
    });
    notFollowingBack.sort((a, b) => b.my_out_replies - a.my_out_replies || b.followers - a.followers);

    return {
      me,
      summary: {
        following: followingSet.size,
        followers: followersSet.size,
        mutual: mutualCount,
        not_following_back: notFollowingBack.length,
        my_original_posts: myOriginal.size,
        total_tweets: Object.keys(tweets).length,
        total_replies: replyRows.length,
        clean_orig_likes: likeRows.length,
        return_counts: {
          S: returnBoard.filter((x) => x.tier === "S").length,
          A: returnBoard.filter((x) => x.tier === "A").length,
          B: returnBoard.filter((x) => x.tier === "B").length,
          C: returnBoard.filter((x) => x.tier === "C").length,
          total: returnBoard.length,
        },
        natural_counts: {
          S: naturalBoard.filter((x) => x.tier === "S").length,
          A: naturalBoard.filter((x) => x.tier === "A").length,
          B: naturalBoard.filter((x) => x.tier === "B").length,
          C: naturalBoard.filter((x) => x.tier === "C").length,
          total: naturalBoard.length,
        },
      },
      returnBoard,
      naturalBoard,
      notFollowingBack,
      likeRows,
    };
  }

  return {
    auditFromRawDb,
    norm,
    toIso,
  };
});
