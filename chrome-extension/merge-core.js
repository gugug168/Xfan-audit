/**
 * 点赞事件的唯一合并规则（UMD：浏览器挂 window.XFanMerge，Node 走 module.exports）。
 *
 * 为什么要有这个文件：
 *   通知 id 不稳定 —— 同一个点赞事件在不同采集会话里 id 不同（3 个家族），
 *   线上 786 条里只有 496 个唯一事件（37% 重复）。用 id 当唯一键，v10 抓到的
 *   正确行永远覆盖不了旧空行，重复和空帖都修不掉。
 *
 * 解决：三键索引，任一命中即合并进已存在的那一条。
 *   n:<nid>            同一次会话内的重复投递
 *   h:<ts>|<handles>   旧空行只有这个键（也是回填的依据）
 *   t:<ts>|<tweet>     同一事件的不同 id 家族
 * 没有 ts 或没有 handles 时不建复合键，宁多不误合。
 *
 * 三个计数严格分开（巡检的 idle 判定靠 newItems，不能被"补字段"污染）：
 *   added     全新事件
 *   upgraded  已有记录被补字段/升 schema（内容变了）
 *   collapsed 命中索引、内容没变、只是重复（被折叠掉）
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.XFanMerge = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function norm(h) {
    return String(h || "").trim().replace(/^@+/, "").trim().toLowerCase();
  }

  function pickTweet(ev) {
    if (!ev) return "";
    if (ev.tweet) return String(ev.tweet);
    if (Array.isArray(ev.tweets) && ev.tweets.length) return String(ev.tweets[0] || "");
    return "";
  }

  function handleList(ev) {
    if (!ev) return [];
    var src = (Array.isArray(ev.likers) && ev.likers.length) ? ev.likers : ev.handles;
    return (src || []).map(norm).filter(Boolean);
  }

  function eventKeys(nid, ev) {
    var keys = [];
    if (nid) keys.push("n:" + nid);
    var ts = (ev && ev.ts) || "";
    var hs = handleList(ev).slice().sort();
    if (!ts || !hs.length) return keys;
    keys.push("h:" + ts + "|" + hs.join(","));
    var tw = pickTweet(ev);
    if (tw) keys.push("t:" + ts + "|" + tw);
    return keys;
  }

  function uniq(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) if (out.indexOf(arr[i]) < 0) out.push(arr[i]);
    return out;
  }

  /** 字段级合并：高 schema 优先，但绝不用空值覆盖非空。 */
  function mergeEvent(prev, next) {
    var sp = Number((prev && prev.schema) || 0);
    var sn = Number((next && next.schema) || 0);
    var hi = sn >= sp ? next : prev;
    var lo = sn >= sp ? prev : next;
    var out = {};

    function put(key, val) {
      if (val === undefined || val === null || val === "" ||
          (Array.isArray(val) && !val.length)) return;
      out[key] = val;
    }

    // 先铺低版本，再让高版本的非空字段覆盖
    [lo, hi].forEach(function (src) {
      if (!src) return;
      Object.keys(src).forEach(function (k) {
        if (k === "ts" || k === "handles" || k === "likers" ||
            k === "tweets" || k === "schema" || k === "clean_v10" || k === "tweet") return;
        put(k, src[k]);
      });
    });

    var tsCand = [prev && prev.ts, next && next.ts].filter(Boolean).sort();
    if (tsCand.length) out.ts = tsCand[0];

    var tweets = uniq((((lo || {}).tweets) || []).concat(((hi || {}).tweets) || []).map(String));
    var tw = pickTweet(hi) || pickTweet(lo);
    if (tw && tweets.indexOf(tw) < 0) tweets.unshift(tw);
    if (tweets.length) out.tweets = tweets;
    if (tw) out.tweet = tw;

    // 点赞者名单：
    //   schema 不同 → 高版本是结构化产出，整体采信（旧的不确定名单会被它纠正）；
    //   schema 相同 → 取并集。X 的聚合通知「A、B 和另外 N 人赞了你」只带部分头像，
    //   同一条通知更新后新旧列表各是一部分，整体替换会丢掉已观察到的点赞者。
    //   并集以已有顺序为准、新人追加在后，所以重复喂同一批数据结果不变。
    var hiLikers = (Array.isArray(hi && hi.likers) && hi.likers.length)
      ? hi.likers.map(norm).filter(Boolean)
      : null;
    var handles = (hiLikers && sp !== sn)
      ? hiLikers
      : uniq(handleList(prev).concat(handleList(next)));
    if (handles.length) {
      out.handles = handles;
      out.likers = handles;
    }

    var schemaMax = Math.max(sp, sn);
    if (schemaMax > 0) out.schema = schemaMax;
    // 只有「所有来源都可信」才能标干净：
    //   schema>=2 = 采集器结构化产出，可信
    //   clean_v10 = 旧版 v10 提取器产出，可信
    // 任一方是未清洗的 legacy，结果就仍可能混有引用作者，不能标干净 ——
    // 否则下游会跳过剥离启发式，把原作者当成点赞者（实测会多算 2 对）。
    if (schemaMax >= 2 || ((prev && prev.clean_v10) && (next && next.clean_v10))) {
      out.clean_v10 = 1;
    }

    if ((next && next.url) || (prev && prev.url)) out.url = (next && next.url) || (prev && prev.url);
    return out;
  }

  function stable(obj) {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return "[" + obj.map(stable).join(",") + "]";
    return "{" + Object.keys(obj).sort().map(function (k) {
      return JSON.stringify(k) + ":" + stable(obj[k]);
    }).join(",") + "}";
  }

  function buildIndex(likes) {
    var idx = new Map();
    Object.keys(likes || {}).forEach(function (nid) {
      eventKeys(nid, likes[nid]).forEach(function (k) {
        if (!idx.has(k)) idx.set(k, nid);
      });
    });
    return idx;
  }

  function findCanonical(idx, nid, ev) {
    var keys = eventKeys(nid, ev);
    for (var i = 0; i < keys.length; i++) {
      if (idx.has(keys[i])) return idx.get(keys[i]);
    }
    return null;
  }

  function registerKeys(idx, canonical, nid, ev) {
    eventKeys(nid, ev).forEach(function (k) {
      if (!idx.has(k)) idx.set(k, canonical);
    });
  }

  /** 把 batch.likes 合并进 db.likes。返回 {added, upgraded, collapsed}。 */
  function mergeDb(db, batch) {
    var counters = { added: 0, upgraded: 0, collapsed: 0 };
    if (!db) return counters;
    if (!db.likes) db.likes = {};
    var incoming = (batch && batch.likes) || {};
    var idx = buildIndex(db.likes);

    Object.keys(incoming).forEach(function (nid) {
      var ev = incoming[nid];
      if (!ev) return;
      var canonical = findCanonical(idx, nid, ev);

      if (!canonical) {
        // 新事件也走一次归一化，保证「同一条再喂一遍」是零变化
        var fresh = mergeEvent({}, ev);
        db.likes[nid] = fresh;
        registerKeys(idx, nid, nid, fresh);
        counters.added++;
        return;
      }

      var prev = db.likes[canonical];
      var merged = mergeEvent(prev, ev);
      var changed = stable(merged) !== stable(prev);
      if (changed) {
        db.likes[canonical] = merged;
        registerKeys(idx, canonical, canonical, merged);
        counters.upgraded++;
      }
      if (canonical !== nid) {
        // 吸掉了一个不同 id 的重复行：这两件事可以同时发生（既折叠又补了字段）
        registerKeys(idx, canonical, nid, ev);
        counters.collapsed++;
      }
    });
    return counters;
  }

  /**
   * 全库压实：把已经存在的重复行按同一套规则折叠。
   * 一次性迁移用（线上 786 → 496），不在每次 merge 里跑。
   */
  function compact(db) {
    var counters = { added: 0, upgraded: 0, collapsed: 0 };
    if (!db || !db.likes) return counters;
    var old = db.likes;
    var fresh = {};
    var idx = new Map();

    Object.keys(old).forEach(function (nid) {
      var ev = old[nid];
      if (!ev) return;
      var canonical = findCanonical(idx, nid, ev);
      if (!canonical) {
        fresh[nid] = mergeEvent({}, ev);
        registerKeys(idx, nid, nid, fresh[nid]);
        counters.added++;
        return;
      }
      var prev = fresh[canonical];
      var merged = mergeEvent(prev, ev);
      if (stable(merged) !== stable(prev)) {
        fresh[canonical] = merged;
        registerKeys(idx, canonical, canonical, merged);
        registerKeys(idx, canonical, nid, ev);
        counters.upgraded++;
      } else {
        counters.collapsed++;
      }
    });

    db.likes = fresh;
    return counters;
  }

  /**
   * 名单对账：用「这次从 X 页面完整扫到的名单」去纠正库里的名单。
   *
   * 库里的粉丝/关注名单只增不减，取关的人会一直留着。对账是唯一会「删人」的地方，
   * 所以只在确认扫到了名单末尾、并且人数合理时才执行，任何一道检查不过都不动库。
   *
   * opts.complete       本轮是否确认扫到了名单末尾（由调用方判断）
   * opts.minRatio       扫到的人数至少是库里人数的多少倍，默认 0.7。
   *                     防止网络卡住、被限流时只扫到一小部分，就把剩下的人都当成取关
   * opts.expectedCount  X 资料页上显示的总数（来自采集到的用户资料），0/缺省表示未知
   * opts.countRatio     扫到的人数至少是 expectedCount 的多少倍，默认 0.9
   *
   * 返回 { applied, reason, before, seen, next, removed, added }。
   * applied=false 时 reason 是：incomplete | empty | too_few_vs_db | too_few_vs_profile
   */
  // 名单对账（v1.8 语义）：只增不减。
  //
  // 旧语义是「用本轮扫到的快照替换整张名单」，前提是一次能扫全。实测 X 单次只给
  // 400/200 人（约 20/10 页）就停，于是 70%/90% 两道闸永远拒绝，用户永远补不齐。
  // 现在改成：
  //   · next = 旧名单 ∪ 本轮看到的人 —— 只加不减，扫到多少就补多少
  //   · 只有「确认翻到名单底部」的那一轮，才对「库里有、本轮没看到」的人打疑似取关标记
  //   · 真正移出改成手动确认（沿用 lists_removed 的可恢复语义）
  // 参数 opts.complete 只影响「要不要判定取关」，不再决定「能不能写库」。
  function reconcileList(current, seen, opts) {
    opts = opts || {};

    var curMap = {};
    Object.keys(current || {}).forEach(function (h) { var k = norm(h); if (k) curMap[k] = 1; });
    var cur = Object.keys(curMap);

    var seenMap = {};
    (seen || []).forEach(function (h) { var k = norm(h); if (k) seenMap[k] = 1; });
    var seenArr = Object.keys(seenMap);

    var res = { applied: false, reason: "", complete: !!opts.complete,
                before: cur.length, seen: seenArr.length,
                next: null, added: [], suspects: [], suspectsSkipped: false };

    // 一个人都没看到 = 页面没加载出来，宁可不动，也不能把空名单当成「大家都取关了」
    if (!seenArr.length) { res.reason = "empty"; return res; }

    res.added = seenArr.filter(function (h) { return !curMap[h]; });
    res.next = {};
    cur.forEach(function (h) { res.next[h] = 1; });
    seenArr.forEach(function (h) { res.next[h] = 1; });

    // 只有确认到底的那一轮才判定「谁不在了」；没到底就只补不判，避免把没翻到的人当成取关
    if (opts.complete) {
      var suspectMin = opts.suspectMinRatio == null ? 0.5 : opts.suspectMinRatio;
      // 本轮扫到的人不到库里一半：说明这次根本没翻动（限流/页面没加载），
      // 这时候「谁没出现」全是误报。宁可这一轮不判定，也不给用户一堆假取关。
      if (!cur.length || seenArr.length >= cur.length * suspectMin) {
        res.suspects = cur.filter(function (h) { return !seenMap[h]; });
      } else {
        res.suspectsSkipped = true;
      }
    }
    res.applied = true;
    return res;
  }

  return {
    norm: norm,
    reconcileList: reconcileList,
    pickTweet: pickTweet,
    handleList: handleList,
    eventKeys: eventKeys,
    mergeEvent: mergeEvent,
    mergeDb: mergeDb,
    compact: compact,
  };
});
