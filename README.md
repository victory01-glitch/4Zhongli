# 中壢民生案件儀表板

議員辦公室共用的選民服務工具：彙整桃園市 1999 市政信箱陳情案件，鎖定中壢區，
協助掌握案量、逾期案件與案件類別分布。

## 架構

```
瀏覽器（網頁）  →  自己的後端 /api/cases  →  桃園市政府開放資料平台
```

瀏覽器不能直接呼叫政府 API（會被 CORS 擋掉），所以由後端伺服器代為呼叫，
並快取 5 分鐘，避免每次操作都重打政府 API，也保護自己不超過政府規定的
「單日 6000 次、間隔 30 秒」限制。

## 本機測試

需要 Node.js 18 以上（內建 fetch）。

```bash
npm install
npm start
```

打開瀏覽器到 http://localhost:3000 即可看到儀表板。

## 部署（挑一個免費方案即可）

以下三個都支援「連 GitHub repo 自動部署」，設定完成後之後你只要 push code，
網站就會自動更新，不用手動上傳。

### 方案一：Render（推薦，最簡單）
1. 把這個資料夾推到一個 GitHub repo
2. 到 https://render.com 註冊，選「New Web Service」
3. 連接你的 repo
4. Build Command 留空，Start Command 填 `npm start`
5. 部署完成後會拿到一個 `https://xxx.onrender.com` 的網址，直接分享給議員辦公室

### 方案二：Railway
1. 到 https://railway.app 註冊，New Project → Deploy from GitHub repo
2. Railway 會自動偵測 Node.js 專案並部署
3. 部署完成後在 Settings 裡產生一個公開網址

### 方案三：Vercel
Vercel 主要是設計給 serverless function 用的，需要把 `server.js` 的路由
改寫成 `/api/cases.js` 這種 serverless function 格式。如果你想用 Vercel，
跟我說一聲，我再幫你改寫成對應格式。

## 之後可以再加的功能

- **登入分辦公室**：目前是公開/內部共用網址，之後如果要讓不同議員辦公室
  各自登入、各自標記案件處理進度，需要加使用者系統（例如用 Clerk 或
  Auth0 這類服務，比自己刻登入系統快很多）。
- **LINE 通知**：新案件或即將逾期的案件主動推播給助理，可以在
  `server.js` 裡加一個排程（例如用 `node-cron`），定期檢查快取資料並打
  LINE Notify 或 LINE Bot API。
- **歷史資料庫**：目前只快取「最新一次抓到的資料」，沒有存歷史。如果要
  做「這個月中壢案件比上個月增加多少」這種趨勢分析，就要真的把每次抓到
  的資料存進資料庫（例如 Postgres），而不只是記憶體快取。

## 檔案結構

```
zhongli-app/
├── server.js          後端伺服器（代理政府 API + 快取）
├── package.json
├── public/
│   └── index.html      前端頁面（儀表板介面）
└── README.md
```

## ⚠️ 尚未驗證事項

我目前的開發環境網路白名單無法連到 `data.tycg.gov.tw`，所以 `server.js`
裡呼叫政府 API 的邏輯**還沒有實際測試過**，只是照政府文件上寫的 API 網址
和欄位名稱寫的。你部署上線、第一次打開網頁後：

- 如果狀態列顯示「資料已更新」→ 成功了
- 如果顯示「後端尚未部署或無法連線，改用示範資料」→ 到部署平台看
  server 的 log，把錯誤訊息貼給我，我再依實際錯誤調整
  `normalizeRecord()` 裡的欄位名稱對應（政府 API 回傳的實際 JSON 欄位
  名稱，很可能跟文件描述有些微差異）
