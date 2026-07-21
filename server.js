// server.js
// 中壢民生案件儀表板 — 後端代理伺服器
//
// 這支伺服器做兩件事：
// 1. 伺服器端呼叫桃園市政府開放資料 API（伺服器對伺服器沒有瀏覽器的 CORS 限制）
// 2. 把資料快取在記憶體裡（預設 5 分鐘），避免每個使用者的每次操作都重打政府 API，
//    也保護自己不誤觸政府規定的「單日 6000 次、間隔 30 秒」限制。
//
// 部署方式見 README.md

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// 政府開放資料 API（桃園市政信箱案件資訊）
const GOV_API_URL =
  "https://data.tycg.gov.tw/api/v1/rest/datastore/64c62af1-481b-4040-8a9e-1680e330eb17?format=json";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分鐘快取
let cache = { data: null, fetchedAt: 0 };

// 把政府 API 回傳的原始欄位，轉成前端要用的固定格式。
// 如果政府那邊改欄位名稱，只要改這個函式就好，不用動前端。
function normalizeRecord(raw) {
  return {
    id: raw["案件編號"] || raw.caseId || raw.id || "-",
    date: raw["受理日期"] || raw.acceptDate || raw.date || "",
    category: raw["案件類別"] || raw.category || "未分類",
    district: raw["行政區"] || raw.district || "",
    addr: raw["案件地址"] || raw.address || "",
    status: raw["案件狀態"] || raw.status || "處理中",
    due: raw["應辦結日"] || raw.dueDate || "",
    note: raw["案件內容"] || raw.content || "",
  };
}

async function fetchFromGov() {
  const res = await fetch(GOV_API_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`政府 API 回應錯誤：HTTP ${res.status}`);
  }
  const json = await res.json();

  // 不同資料開放平台的 JSON 外層結構可能不同，這裡盡量相容常見幾種格式。
  const records = Array.isArray(json)
    ? json
    : json.result?.records || json.records || [];

  if (!records.length) {
    throw new Error("政府 API 回傳資料為空，可能是資料集結構已變更");
  }

  return records
    .map(normalizeRecord)
    .filter((r) => (r.district || "").includes("中壢"));
}

// GET /api/cases  — 前端唯一需要呼叫的端點
app.get("/api/cases", async (req, res) => {
  const now = Date.now();
  const cacheIsFresh = cache.data && now - cache.fetchedAt < CACHE_TTL_MS;

  if (cacheIsFresh) {
    return res.json({
      source: "cache",
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
      count: cache.data.length,
      cases: cache.data,
    });
  }

  try {
    const cases = await fetchFromGov();
    cache = { data: cases, fetchedAt: now };
    res.json({
      source: "live",
      fetchedAt: new Date(now).toISOString(),
      count: cases.length,
      cases,
    });
  } catch (err) {
    // 政府 API 打不通時，如果手上還有舊快取，寧可回傳舊資料也不要整頁掛掉，
    // 並且老實告訴前端這是「過期資料」，不要假裝是最新的。
    if (cache.data) {
      return res.json({
        source: "stale-cache",
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        count: cache.data.length,
        cases: cache.data,
        warning: err.message,
      });
    }
    res.status(502).json({
      source: "error",
      message: "無法從政府開放資料平台取得資料",
      detail: err.message,
      // 除錯用：Node fetch 的底層錯誤代碼（例如 ENOTFOUND、ECONNREFUSED、
      // CERT_HAS_EXPIRED 等），能看出是 DNS、連線被拒、還是憑證問題。
      // 確認問題排除後，建議把這行拿掉，避免對外暴露內部錯誤細節。
      debugCause: err.cause ? { code: err.cause.code, message: err.cause.message } : null,
    });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---------- PTT「Taoyuan」板 中壢相關貼文掃描 ----------

const cheerio = require("cheerio");

const PTT_BOARDS = [
  { name: "Taoyuan", url: "https://www.ptt.cc/bbs/Taoyuan/index.html", requireKeyword: true },
  { name: "ChungLi", url: "https://www.ptt.cc/bbs/ChungLi/index.html", requireKeyword: false },
];
const PTT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; ZhongliDashboardBot/0.1)",
  Cookie: "over18=1",
};

// 用來初步判斷貼文是不是「民怨/陳情」類型，只看標題，抓到幾個常見字眼就好，
// 不追求完美，抓漏比抓錯更能接受（漏掉的可以靠人工補，抓錯的話助理會白花時間看）。
const COMPLAINT_KEYWORDS = [
  "抱怨", "陳情", "投訴", "檢舉", "罰單", "違規", "違建", "擾民", "危險",
  "坑洞", "淹水", "惹怨", "不滿", "抗議", "噪音", "塞車", "肇事", "事故",
  "亂停", "違停", "施工", "停電", "斷水", "異味", "污染", "破損",
];

function guessIsComplaint(title) {
  return COMPLAINT_KEYWORDS.some((k) => title.includes(k));
}

// 從文章連結取得年份、日期比較準：PTT 文章網址通常是 M.<unix timestamp>.A.XXX.html
function extractDateFromUrl(url) {
  const m = url.match(/M\.(\d{9,10})\./);
  if (!m) return "";
  const d = new Date(Number(m[1]) * 1000);
  return d.toISOString().slice(0, 10);
}

async function fetchPttPage(url) {
  const res = await fetch(url, { headers: PTT_HEADERS });
  if (!res.ok) throw new Error(`PTT 回應錯誤：HTTP ${res.status}`);
  return res.text();
}

// 從板頁面找出「上一頁」的連結，藉此往前翻頁
function findPrevPageUrl(html) {
  const $ = cheerio.load(html);
  const prevLink = $(".btn-group-paging a")
    .filter((i, el) => $(el).text().includes("上頁"))
    .attr("href");
  if (!prevLink) return null;
  return "https://www.ptt.cc" + prevLink;
}

function parseArticles(html) {
  const $ = cheerio.load(html);
  const items = [];
  $(".r-ent").each((i, el) => {
    const titleEl = $(el).find(".title a");
    const title = titleEl.text().trim();
    const href = titleEl.attr("href");
    if (!title || !href) return; // 沒有連結代表文章被刪除，跳過
    const author = $(el).find(".meta .author").text().trim();
    const pushText = $(el).find(".nrec").text().trim();
    const url = "https://www.ptt.cc" + href;
    items.push({
      title,
      url,
      author,
      pushCount: pushText || "0",
      date: extractDateFromUrl(url),
    });
  });
  return items;
}

const PTT_CACHE_TTL_MS = 20 * 60 * 1000; // 20 分鐘快取，避免太常打 PTT
let pttCache = { data: null, fetchedAt: 0 };

async function fetchZhongliPostsFromPtt(pagesToScan = 6) {
  let allArticles = [];

  for (const board of PTT_BOARDS) {
    let html = await fetchPttPage(board.url);
    let boardArticles = parseArticles(html).map((a) => ({ ...a, board: board.name }));

    for (let i = 1; i < pagesToScan; i++) {
      const prevUrl = findPrevPageUrl(html);
      if (!prevUrl) break;
      html = await fetchPttPage(prevUrl);
      boardArticles = boardArticles.concat(
        parseArticles(html).map((a) => ({ ...a, board: board.name }))
      );
    }

    const relevant = board.requireKeyword
      ? boardArticles.filter((a) => a.title.includes("中壢"))
      : boardArticles; // ChungLi 板本身就是中壢板，不用再篩關鍵字

    allArticles = allArticles.concat(relevant);
  }

  return allArticles
    .map((a) => ({ ...a, likelyComplaint: guessIsComplaint(a.title) }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// GET /api/ptt-posts — 前端呼叫這支拿 PTT 中壢相關貼文
app.get("/api/ptt-posts", async (req, res) => {
  const now = Date.now();
  const cacheIsFresh = pttCache.data && now - pttCache.fetchedAt < PTT_CACHE_TTL_MS;

  if (cacheIsFresh) {
    return res.json({
      source: "cache",
      fetchedAt: new Date(pttCache.fetchedAt).toISOString(),
      count: pttCache.data.length,
      posts: pttCache.data,
    });
  }

  try {
    const posts = await fetchZhongliPostsFromPtt(4);
    pttCache = { data: posts, fetchedAt: now };
    res.json({
      source: "live",
      fetchedAt: new Date(now).toISOString(),
      count: posts.length,
      posts,
    });
  } catch (err) {
    if (pttCache.data) {
      return res.json({
        source: "stale-cache",
        fetchedAt: new Date(pttCache.fetchedAt).toISOString(),
        count: pttCache.data.length,
        posts: pttCache.data,
        warning: err.message,
      });
    }
    res.status(502).json({
      source: "error",
      message: "無法從 PTT 取得資料",
      detail: err.message,
    });
  }
});

// 提供前端靜態檔案
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`中壢民生案件儀表板伺服器啟動：http://localhost:${PORT}`);
});
