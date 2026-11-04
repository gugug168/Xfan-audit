/**
 * X-Fan Audit - Background Service Worker (background.js)
 * 1. 维护无限容量 chrome.storage.local 数据库 (xfan_db_v10)
 * 2. 精确统计每批次「真正新增」的推文/通知/粉丝 ID 数
 * 3. 调度「一键 90 秒每日增量巡检」（遇到历史已采 ID 连续 3 轮无新增即停，自动切下一页）与「全量深采」
 */

importScripts("merge-core.js");
const XFanMerge = self.XFanMerge;

const DB_KEY = "xfan_db_v10";

let dbCache = null;
let saveTimer = null;
let lastLikeStats = { added: 0, upgraded: 0, collapsed: 0 };
let patrolState = {
  running: false,
  mode: "incremental",
  currentTask: "",
  statusText: "",
  tabId: null,
  newItemsSinceLastCheck: 0,
};

function emptyDb() {
  return {
    me: "",
    updated_at: new Date().toISOString(),
    lists: { following: {}, followers: {} },
    users: {},
    tweets: {},
    likes: {},
  };
}

async function getDb() {
  if (dbCache) return dbCache;
  const res = await chrome.storage.local.get([DB_KEY]);
  dbCache = res[DB_KEY] || emptyDb();
  if (!dbCache.lists) dbCache.lists = { following: {}, followers: {} };
  if (!dbCache.lists.following) dbCache.lists.following = {};
  if (!dbCache.lists.followers) dbCache.lists.followers = {};
  if (!dbCache.users) dbCache.users = {};
  if (!dbCache.tweets) dbCache.tweets = {};
  if (!dbCache.likes) dbCache.likes = {};
  return dbCache;
}

// 只有头像/资料这类「次要变化」走长防抖；有新数据的变化仍然立即 flushSave。
const SAVE_DEBOUNCE_MS = 500;
const SAVE_DEBOUNCE_QUIET_MS = 5000;

function scheduleSave(delay = SAVE_DEBOUNCE_MS) {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await flushSave();
  }, delay);
}

// MV3 的 service worker 随时可能被回收：500ms 防抖期间收到 batch 就落盘，
// 避免最后一批数据随 SW 一起消失。
async function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dbCache) return;
  dbCache.updated_at = new Date().toISOString();
  await chrome.storage.local.set({ [DB_KEY]: dbCache });
}

function getStatsSummary(db) {
  return {
    me: db.me || "",
    updated_at: db.updated_at || "",
    following: Object.keys(db.lists.following || {}).length,
    followers: Object.keys(db.lists.followers || {}).length,
    users: Object.keys(db.users || {}).length,
    tweets: Object.keys(db.tweets || {}).length,
    likes: Object.keys(db.likes || {}).length,
  };
}

const USER_FIELDS = ["id", "handle", "name", "avatar", "followers", "following", "verified", "created"];

// 缺字段、0、false、"" 都算「空」，视为相同：页面上报的部分资料（只有 handle+avatar）
// 与补全后的完整资料不该被判成不同，否则每个新用户都会多触发一次写盘。
function sameUser(a, b) {
  return USER_FIELDS.every((k) => (a[k] || "") === (b[k] || ""));
}

// 对账用：只在「全量深采」翻粉丝页/关注页时才是 Set，其余时间为 null（不记录，不占内存）。
const reconcileSeen = { followers: null, following: null };

async function mergeBatch(batch, isFullImport = false) {
  const db = await getDb();
  let newItems = 0;
  // dirty：库内容确实变了，但变的不是「新数据」（如头像、资料、me）。
  // 没有任何变化就不写盘 —— 页面每 2.5 秒都会重发同样的头像批次。
  let dirty = false;

  if (batch.me && /^[a-z0-9_]{1,15}$/i.test(batch.me)) {
    const m = batch.me.toLowerCase();
    if (db.me !== m) {
      db.me = m;
      dirty = true;
    }
  }
  if (batch.seed_version && db.seed_version !== batch.seed_version) {
    db.seed_version = String(batch.seed_version);
    dirty = true;
  }

  // 合并关注与粉丝列表
  // 对账进行中时，另外记下「本轮在这个名单页上看到的所有人」（含库里早就有的），
  // 用来在翻到底之后判断谁已经不在名单里了。
  if (batch.lists) {
    for (const h of Object.keys(batch.lists.following || {})) {
      const k = h.toLowerCase();
      if (reconcileSeen.following) reconcileSeen.following.add(k);
      if (!db.lists.following[k]) {
        db.lists.following[k] = 1;
        newItems++;
      }
    }
    for (const h of Object.keys(batch.lists.followers || {})) {
      const k = h.toLowerCase();
      if (reconcileSeen.followers) reconcileSeen.followers.add(k);
      if (!db.lists.followers[k]) {
        db.lists.followers[k] = 1;
        newItems++;
      }
    }
  }

  // 合并用户资料
  for (const [h, u] of Object.entries(batch.users || {})) {
    const k = h.toLowerCase();
    const prev = db.users[k];
    if (!prev) {
      db.users[k] = u;
      dirty = true;
    } else {
      const merged = {
        id: u.id || prev.id || "",
        handle: k,
        name: u.name || prev.name || "",
        avatar: u.avatar || prev.avatar || "",
        followers: u.followers || prev.followers || 0,
        following: u.following || prev.following || 0,
        verified: Boolean(u.verified || prev.verified),
        created: u.created || prev.created || "",
      };
      if (!sameUser(prev, merged)) {
        db.users[k] = merged;
        dirty = true;
      }
    }
  }

  // 合并推文
  for (const [tid, t] of Object.entries(batch.tweets || {})) {
    if (!db.tweets[tid]) {
      db.tweets[tid] = t;
      newItems++;
    } else if (!db.tweets[tid].author && t.author) {
      // 补作者是修复旧行，不是新数据：不能计入 newItems，否则会拖慢巡检的 idle 判定
      db.tweets[tid].author = t.author;
      dirty = true;
    }
  }

  // 合并点赞通知：走唯一的合并规则（三键索引 + 字段级合并）
  // added 才计入 newItems —— upgraded/collapsed 不能驱动巡检的 idle 判定，
  // 否则「补字段」会被当成「有新数据」，90 秒巡检会一直跑满不切页。
  const likeStats = XFanMerge.mergeDb(db, batch);
  newItems += likeStats.added;
  // collapsed 只是命中索引的重复行，db.likes 没有任何变化，不该触发整库写盘；
  // 只有 added / upgraded 才意味着库内容变了。
  const likeChanged = likeStats.added + likeStats.upgraded;
  lastLikeStats = likeStats;

  patrolState.newItemsSinceLastCheck += newItems;
  if (isFullImport) {
    db.updated_at = new Date().toISOString();
    await chrome.storage.local.set({ [DB_KEY]: db });
  } else if (newItems > 0 || likeChanged > 0) {
    await flushSave();          // 有新数据或被补齐字段，立即落盘
  } else if (dirty) {
    scheduleSave(SAVE_DEBOUNCE_QUIET_MS);   // 头像/资料/me 的次要变化，合并后慢写
  }
  return { stats: getStatsSummary(db), newItems };
}

function buildPatrolTasks(me, mode) {
  // 增量巡检：优先巡检高频互动页（主帖、回复、别人回我、点赞通知、新粉丝、新关注）
  // 遇到连续 idleThreshold 轮无新 ID 入库即判定「已接上历史断点」，立即跳下一页
  const idleLimit = mode === "incremental" ? 3 : 12;
  const maxRounds = mode === "incremental" ? 20 : 180;
  return [
    { key: "posts", label: "原创主帖", url: `https://x.com/${me}`, idleLimit, maxRounds },
    { key: "notifications", label: "点赞通知", url: "https://x.com/notifications", idleLimit, maxRounds },
    { key: "incoming", label: "别人回我", url: `https://x.com/search?q=to%3A${me}&src=typed_query&f=live`, idleLimit, maxRounds },
    { key: "replies", label: "我发出的回复", url: `https://x.com/${me}/with_replies`, idleLimit, maxRounds },
    { key: "followers", label: "新增粉丝", url: `https://x.com/${me}/followers`, idleLimit: mode === "incremental" ? 2 : 12, maxRounds },
    { key: "following", label: "新增关注", url: `https://x.com/${me}/following`, idleLimit: mode === "incremental" ? 2 : 12, maxRounds },
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function broadcastPatrolStatus(statusText) {
  const db = await getDb();
  const stats = getStatsSummary(db);
  patrolState.statusText = statusText;
  // 通知所有扩展页面（如 dashboard.html）
  try {
    chrome.runtime.sendMessage({
      type: "XFAN_PATROL_STATUS",
      statusText,
      patrolRunning: patrolState.running,
      stats,
    }).catch(() => {});
  } catch (e) {}
  // 通知所有 x.com 标签页，而不只是被巡检的那个：
  // 否则在 A 标签点了巡检、被驱动的是 B 标签时，A 的悬浮窗一直显示「空闲」，
  // 用户会以为没启动而反复点击（真实浏览器测试中发生过）。
  const msg = {
    type: "XFAN_PATROL_STATUS",
    statusText,
    patrolRunning: patrolState.running,
    stats,
  };
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: X_TAB_URLS });
  } catch (e) {}
  await Promise.all(
    tabs.map((t) => chrome.tabs.sendMessage(t.id, msg).catch(() => {}))
  );
}

const X_TAB_URLS = ["https://x.com/*", "https://twitter.com/*"];
const isUsableXTab = (t) => !!(t && t.id != null && /^https:\/\/(x|twitter)\.com\//.test(t.url || "") && !(t.url || "").includes("/compose"));

// 选巡检要接管的标签页，优先级：
//   1. 发起巡检的那个 x.com 标签页（从悬浮窗点的）
//   2. 当前窗口里正在看的 x.com 标签页（从大屏点的、或从别处触发）
//   3. 任意一个 x.com 标签页
//   4. 都没有就新建
// 原来只取 tabs.query 的第一个，常常接管用户另一个正在用的标签页。
async function pickPatrolTab(preferTabId, me) {
  if (preferTabId != null) {
    try {
      const t = await chrome.tabs.get(preferTabId);
      if (isUsableXTab(t)) return t;
    } catch (e) {}
  }
  try {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: X_TAB_URLS });
    const t = active.find(isUsableXTab);
    if (t) return t;
  } catch (e) {}
  try {
    const any = await chrome.tabs.query({ url: X_TAB_URLS });
    const t = any.find(isUsableXTab);
    if (t) return t;
  } catch (e) {}
  return chrome.tabs.create({ url: `https://x.com/${me}`, active: true });
}

// 对账判定「到底了」：本轮累计看到的人数连续这么多轮没有增长。
// 每轮约 2 秒，X 的列表一次加载 20 个左右，12 轮 = 约 24 秒没有新人出现。
const RECONCILE_FLAT_ROUNDS = 12;

// 用「完整扫到的名单」纠正库里的名单。库里的名单只增不减，这是唯一会删人的地方。
// 被移出的人不会真删，而是存进 db.lists_removed[kind][handle] = 移出时间，可以恢复。
async function applyReconcile(kind, seen, reachedEnd) {
  const label = kind === "followers" ? "粉丝" : "关注";
  const db = await getDb();
  if (!db.lists_removed) db.lists_removed = { followers: {}, following: {} };
  if (!db.lists_removed[kind]) db.lists_removed[kind] = {};

  // X 资料页显示的总数：由页面采集写进自己账号的用户资料里
  const meUser = (db.users && db.me && db.users[db.me]) || {};
  const expected = Number(kind === "followers" ? meUser.followers : meUser.following) || 0;

  const r = XFanMerge.reconcileList(db.lists[kind], seen, {
    complete: reachedEnd,
    expectedCount: expected,
  });

  if (!r.applied) {
    const why = {
      incomplete: "没有确认翻到名单底部",
      empty: "没有看到任何人（页面可能没加载出来）",
      too_few_vs_db: `只看到 ${r.seen} 人，不到库里 ${r.before} 人的 70%`,
      too_few_vs_profile: `只看到 ${r.seen} 人，不到主页显示的 ${expected} 人的 90%`,
    }[r.reason] || r.reason;
    return `⚠ ${label}名单未对账（${why}），库里的名单没有改动`;
  }

  const now = new Date().toISOString();
  r.removed.forEach((h) => { db.lists_removed[kind][h] = now; });
  // 重新出现的人要从「已移出」里拿掉。
  // 不能只清 r.added：翻页过程中 mergeBatch 已经把新面孔追加进了 db.lists，
  // 到对账时这些人已经在「当前名单」里，不再算 added，只清 added 会让回关的人永远挂在 lists_removed 里。
  seen.forEach((h) => { delete db.lists_removed[kind][h]; });
  db.lists[kind] = r.next;
  await flushSave();
  // 没取到主页显示的总数时，第三道保护闸没有生效：必须如实说明，不能悄悄当作通过
  const note = expected > 0 ? "" : "（未能取得主页显示的总数，请自行核对）";
  // 诊断：本轮扫到的人里，有多少没有 API 资料（用户记录的 id 为空）。
  // 这类人只可能来自页面兜底扫描，不是 X 接口返回的名单条目；数量多说明有无关账号混入。
  // 实测里名单比主页多出的数量正好与这个数吻合，所以直接报告，不再需要从库里反推。
  const noApi = r.next ? Object.keys(r.next).filter((h) => !(db.users && db.users[h] && db.users[h].id)).length : 0;
  const noApiNote = noApi > 0 ? `，其中 ${noApi} 人没有 API 资料（可能是页面推荐的无关账号）` : "";
  return `✓ ${label}名单已对账：现有 ${r.seen} 人，移出 ${r.removed.length} 人，新增 ${r.added.length} 人${noApiNote}${note}`;
}

// 每次启动巡检拿一个唯一代号。停止后立刻重新开始时，旧循环可能还卡在 sleep 里：
// 只靠 running 布尔值，旧循环醒来会看到 running 又变回 true，和新循环一起驱动同一个标签页。
// 代号不一致就说明「我已经不是当前这一轮」，必须退出。
let patrolRunId = 0;

async function runPatrol(mode = "incremental", preferTabId = null) {
  if (patrolState.running) return;
  patrolState.running = true;
  patrolState.mode = mode;
  const runId = ++patrolRunId;
  const alive = () => patrolState.running && patrolRunId === runId;
  let finished = false;   // true = 全部任务跑完；false = 被停止或中断
  const reconcileReport = [];   // 对账结果文字，最后一起显示

  try {
    const db = await getDb();
    const me = db.me || "";
    if (!me) {
      patrolState.running = false;
      await broadcastPatrolStatus("未识别到你的 X 账号：请先在 x.com 打开一次自己的主页，让扩展识别后再巡检");
      return;
    }
    const tasks = buildPatrolTasks(me, mode);

    const targetTab = await pickPatrolTab(preferTabId, me);
    await chrome.tabs.update(targetTab.id, { active: true });
    patrolState.tabId = targetTab.id;

    for (let i = 0; i < tasks.length; i++) {
      if (!alive()) break;
      const task = tasks[i];
      patrolState.currentTask = task.label;
      await broadcastPatrolStatus(`[${i + 1}/${tasks.length}] 正在巡检「${task.label}」...`);

      // 对账：全量模式下的粉丝页/关注页要一直翻到名单底部，并记下看到的所有人。
      // 在导航「之前」就开始记录，是防御性的写法：页面加载期间就可能有名单批次到达，
      // 先建好空集合就不会漏记。注意：测试里没能复现「晚初始化会漏记」，这里只是更稳妥，
      // 不是一个已被验证的缺陷修复。
      const reconcileKey = mode === "full" && (task.key === "followers" || task.key === "following") ? task.key : "";
      if (reconcileKey) reconcileSeen[reconcileKey] = new Set();

      await chrome.tabs.update(targetTab.id, { url: task.url });
      await sleep(5200);
      if (!alive()) break;
      let reachedEnd = false;       // 已确认翻到了名单末尾
      let lastSeenSize = 0;
      let flat = 0;                 // 连续多少轮「看到的人数」没有增长

      let idle = 0;
      for (let round = 1; round <= task.maxRounds; round++) {
        if (!alive()) break;
        patrolState.newItemsSinceLastCheck = 0;
        try {
          await chrome.tabs.sendMessage(targetTab.id, { type: "XFAN_DO_SCROLL" });
        } catch (e) {}
        await sleep(2000);
        if (!alive()) break;

        if (reconcileKey) {
          // 不能用「库里有没有新增」判断到底：库里已经有 2000 多人，翻页看到的几乎全是已知面孔，
          // 连续几轮「无新增」很快就会误判为到底。改看本轮页面上累计看到的人数是否还在增长。
          const size = reconcileSeen[reconcileKey].size;
          flat = size > lastSeenSize ? 0 : flat + 1;
          lastSeenSize = size;
          await broadcastPatrolStatus(
            `[${i + 1}/${tasks.length}] ${task.label}：已看到 ${size} 人（第 ${round} 屏，到底判定 ${flat}/${RECONCILE_FLAT_ROUNDS}）`
          );
          if (flat >= RECONCILE_FLAT_ROUNDS) { reachedEnd = true; break; }
          continue;
        }

        const gained = patrolState.newItemsSinceLastCheck;
        if (gained === 0) {
          idle++;
          await broadcastPatrolStatus(
            `[${i + 1}/${tasks.length}] ${task.label}：核对历史断点 (${idle}/${task.idleLimit})`
          );
          if (idle >= task.idleLimit) {
            break; // 已接上昨天采集过的断点，立刻切下一页
          }
        } else {
          idle = 0;
          await broadcastPatrolStatus(
            `[${i + 1}/${tasks.length}] ${task.label}：+${gained} 条新记录 (第 ${round} 屏)`
          );
        }
      }

      // 对账：只有「确认翻到了名单底部」并且这一轮没被停止，才用扫到的名单纠正库里的名单
      if (reconcileKey) {
        const seen = Array.from(reconcileSeen[reconcileKey]);
        reconcileSeen[reconcileKey] = null;     // 无论结果如何都停止记录
        if (alive()) {
          const msg = await applyReconcile(reconcileKey, seen, reachedEnd);
          reconcileReport.push(msg);
          await broadcastPatrolStatus(`[${i + 1}/${tasks.length}] ${msg}`);
          await sleep(1500);
        }
      }
    }

    // 被停止（或被新一轮取代）时也要把已采到的数据落盘，但不能报「已完成」
    finished = alive();
    if (dbCache) {
      dbCache.updated_at = new Date().toISOString();
      await chrome.storage.local.set({ [DB_KEY]: dbCache });
    }
    if (finished) {
      const modeLabel = mode === "full" ? "全量深采" : "增量巡检";
      // 对账结果必须让用户看到，尤其是「被保护闸拒绝」的情况
      const detail = reconcileReport.length ? " " + reconcileReport.join("；") : "";
      await broadcastPatrolStatus(`✅ ${modeLabel}已完成！${detail}`);
      await sleep(reconcileReport.length ? 6000 : 1000);
      await broadcastPatrolStatus("");
      openDashboardTab();
    }
  } catch (err) {
    await broadcastPatrolStatus("⚠ 巡检中断: " + (err && err.message ? err.message : String(err)));
  } finally {
    // 只有自己仍是当前这一轮才清理共享状态；否则会把已经重新开始的新一轮标成「未运行」
    if (patrolRunId === runId) {
      patrolState.running = false;
      patrolState.currentTask = "";
    }
  }
}

function openDashboardTab() {
  const url = chrome.runtime.getURL("dashboard.html");
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.tabs.reload(tabs[0].id);
    } else {
      chrome.tabs.create({ url });
    }
  });
}

chrome.action.onClicked.addListener(() => {
  openDashboardTab();
});

// service worker 被回收前，把还在防抖等待的改动落盘（尽力而为）
chrome.runtime.onSuspend.addListener(() => {
  if (saveTimer) flushSave();
});

// 首次安装或重载插件时，自动唤醒所有已打开的非发帖 X 标签页注入脚本并迁移旧数据
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
    for (const t of tabs) {
      if (!(t.url || "").includes("/compose")) {
        chrome.tabs.reload(t.id);
      }
    }
  } catch (e) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "XFAN_BATCH" || msg.type === "XFAN_MIGRATE_LEGACY") {
    mergeBatch(msg.payload, msg.type === "XFAN_MIGRATE_LEGACY").then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (msg.type === "XFAN_ME_HANDLE") {
    getDb().then((db) => {
      if (msg.payload && /^[a-z0-9_]{1,15}$/i.test(msg.payload)) {
        const h = msg.payload.toLowerCase();
        if (db.me !== h) {          // 页面每 2.5 秒都会上报，没变就不写盘
          db.me = h;
          scheduleSave();
        }
      }
      sendResponse({ stats: getStatsSummary(db) });
    });
    return true;
  }

  if (msg.type === "XFAN_GET_STATS") {
    getDb().then((db) => {
      sendResponse({
        stats: getStatsSummary(db),
        patrolRunning: patrolState.running,
        patrolStatus: patrolState.statusText,
      });
    });
    return true;
  }

  if (msg.type === "XFAN_GET_FULL_DB") {
    getDb().then((db) => {
      sendResponse({ db, patrolState });
    });
    return true;
  }

  if (msg.type === "XFAN_IMPORT_JSON") {
    mergeBatch(msg.payload, true).then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (msg.type === "XFAN_START_PATROL") {
    // 从 x.com 悬浮窗发起时 sender.tab 就是那个标签页；从大屏发起时没有
    runPatrol(msg.mode || "incremental", sender && sender.tab ? sender.tab.id : null);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "XFAN_STOP_PATROL") {
    patrolState.running = false;
    patrolRunId++;   // 让仍在 sleep 的旧循环醒来后认出自己已被取消
    patrolState.currentTask = "";
    broadcastPatrolStatus("已手动停止巡检");
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "XFAN_OPEN_DASHBOARD") {
    openDashboardTab();
    sendResponse({ ok: true });
    return true;
  }
});
