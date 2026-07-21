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

// 測試端點：驗證從這台伺服器能不能連到 Dcard 中壢話題頁
app.get("/api/test-dcard", async (req, res) => {
  const testUrl = "https://www.dcard.tw/topics/%E4%B8%AD%E5%A3%A2";
  try {
    const r = await fetch(testUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    const text = await r.text();
    res.json({
      ok: r.ok,
      status: r.status,
      contentLength: text.length,
      snippet: text.slice(0, 200),
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      message: "連線失敗",
      detail: err.message,
      debugCause: err.cause ? { code: err.cause.code, message: err.cause.message } : null,
    });
  }
});

// 測試端點：驗證從這台伺服器能不能連到 PTT 桃園板
// 用來判斷「連不上」是政府網域專屬的問題，還是這台主機對台灣網站普遍連不上
app.get("/api/test-ptt", async (req, res) => {
  const testUrl = "https://www.ptt.cc/bbs/Taoyuan/index.html";
  try {
    const r = await fetch(testUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ZhongliDashboardBot/0.1)",
        Cookie: "over18=1",
      },
    });
    const text = await r.text();
    res.json({
      ok: r.ok,
      status: r.status,
      contentLength: text.length,
      snippet: text.slice(0, 200),
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      message: "連線失敗",
      detail: err.message,
      debugCause: err.cause ? { code: err.cause.code, message: err.cause.message } : null,
    });
  }
});

// 提供前端靜態檔案
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`中壢民生案件儀表板伺服器啟動：http://localhost:${PORT}`);
});
