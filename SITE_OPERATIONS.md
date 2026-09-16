# RV Dashboard 維運手冊

## 邊界與來源

- 本 repository 只負責 `https://larry890122.github.io/rv-dashboard/`。
- `ib-knowledge-base` 是獨立 peer；本 repo 不得修改或發布它。
- 私人來源位於 Review workspace。抽取程式只讀來源，僅將通過驗證的 `assets/rv-data.json` 與 `assets/luac-bonds.json` 寫入本 repo。
- 稽核 JSON 必須寫到 repo 外；Excel、PPT、PDF、絕對路徑與來源雜湊不得公開。

## 每次開始工作

1. `git fetch origin`，從 `origin/main` 建立 `codex/<task>` branch 或 Codex worktree。
2. 完整閱讀本文件與 `AGENTS.MD`。
3. 執行 `python3 peer_status.py`，記錄知識庫最後穩定版本；peer 暫時離線是警告，不代表可修改對方 repo。
4. 確認 `git status` 沒有不屬於本任務的變更。

## 更新資料

### 網頁自動更新（Excel 嚴格模式）

正式站的「更新資料」頁固定接受 Spread、10Y、30Y、10s30s 四份 `.xlsx`。瀏覽器必須確認 460 個數值完整、92 個內嵌日期一致、percentile 在 0–100% 內，且每筆符合 Min ≤ Median ≤ Max。資料日期必須晚於正式站；同日修正仍走人工 PR。

原始工作簿只在瀏覽器記憶體解析。網路 request 只能包含 `{data: <public snapshot>}`，不得包含工作簿 bytes、檔名、路徑或來源雜湊。Worker 會重做同一套 schema 與數值驗證。

自動資料 PR 的安全條件全部成立才可合併：

- 作者必須等於 repository variable `RV_UPLOAD_APP_LOGIN`。
- branch 必須以 `automation/rv-data-` 開頭。
- PR 必須有 `automated-rv-data` label。
- diff 必須且只能是 `assets/rv-data.json`。
- 快速資料 CI 必須通過；它只驗證公開資料與建置結果，不重跑未變更的網站、Worker 或瀏覽器程式。

任何包含第二個檔案或程式碼的 PR 都不得自動合併。

### LUAC 單券資料

正式來源必須是單一工作表、固定 11 欄、靜態與行情雙區塊的純值 `.xlsx`；只要含公式、缺值、非有限數字、重複或不匹配 ID、或混合資料日，就拒絕整批更新。以下命令只輸出精簡公開 contract，私人 audit 必須在 repo 外：

```sh
python3 scripts/extract_luac.py <LUAC純值.xlsx> \
  --output assets/luac-bonds.json \
  --audit <repo之外>/luac-audit.json
```

Yield、期限或 OAS 超出公開規則時保留原始數值並標記，但預設圖表與所有 LOWESS 曲線排除。自動更新另要求資料日晚於正式快照，且筆數變動不得超過 ±20%；否則必須走人工 PR。

LUAC 自動資料 PR 的安全條件為：作者等於 `RV_UPLOAD_APP_LOGIN`、branch 以 `automation/luac-data-` 開頭、label 為 `automated-luac-data`、diff 只有 `assets/luac-bonds.json`，且完整 CI 通過。`LUAC_UPLOAD_ENABLED` 與網站 `luac_enabled` 是獨立開關，未完成公司網路 preview 與當期資料核對前保持 `false`。

Bloomberg Desktop API 僅可在已登入 Terminal 的公司 Windows 電腦做唯讀實驗：

```powershell
python scripts/probe_bloomberg_luac.py --known-security "<approved Bloomberg ID>" --snapshot-output "$env:TEMP\luac-api.json" --compare "$env:TEMP\luac-excel.json"
```

診斷只輸出成功狀態、筆數、欄位覆蓋與錯誤分類。完整 universe、唯一 ID、必填欄位 100%，且同工作階段比對達 OAS ≤0.5 bp、Yield ≤0.01 個百分點前，不得接正式更新。

### 人工抽取（含投影片 fallback）

```sh
python3 scripts/extract_rv.py \
  --workbooks <Spread.xlsx> <10Y.xlsx> <30Y.xlsx> <10s30s.xlsx> \
  --deck <reviewed-v2-deck.pptx> \
  --date YYYY-MM-DD \
  --slide-date YYYY-MM-DD \
  --audit ../../rv-audits/YYYY-MM-DD.json
```

`--slide-date` 是人工核對後的資料日期，不得用檔案建立或修改時間代替。只要投影片與 Excel 差異超過容許值，抽取器會停止替換公開快照。

如需在 repo 外比對網頁 Excel 嚴格模式，可執行：

```sh
python3 scripts/extract_excel_strict.py \
  --workbooks <Spread.xlsx> <10Y.xlsx> <30Y.xlsx> <10s30s.xlsx> \
  --output <repo之外的暫存JSON>

# 另一個終端先啟動 public/ 靜態站，再比對瀏覽器與 Python 的 sanitized JSON
node scripts/verify_excel_browser_parity.cjs \
  http://127.0.0.1:8766/ <暫存JSON> \
  <Spread.xlsx> <10Y.xlsx> <30Y.xlsx> <10s30s.xlsx>
```

## 建置與驗證

可信任的自動資料 PR 若只修改 `assets/rv-data.json`，會保留既有 `tests` required check 名稱，但只執行：

```sh
python3 publish.py --build-only
python3 scripts/validate_fast_data.py \
  --current assets/rv-data.json \
  --previous <前一版rv-data.json> \
  --public-root public
```

快速驗證要求資料結構與分類完整、460 個有限數值無缺值、Excel 來源、percentile 範圍、Min／Median／Max 排序、新日期，以及公開 JSON、頁面日期與 manifest 相符。Excel 原檔的四份工作簿、工作表與 92 個內嵌日期仍由瀏覽器及 Worker 驗證。

任何程式碼、第二個檔案、不受信任作者／branch／label 的 PR 都走完整 CI：

```sh
python3 publish.py --build-only
python3 -m unittest discover -s tests -v
pnpm run test:model
pnpm run test:worker
pnpm run check:worker
python3 peer_status.py
python3 -m http.server 8766 --directory public
pnpm run test:browser -- http://127.0.0.1:8766/
```

完整 CI 必須通過 RV 與 LUAC schema、LOWESS、460 個摘要值、公開資料防洩漏、連結、manifest 與桌面／平板／手機 Playwright 測試。資料-only commit 合併至 `main` 後沿用快速驗證產生 Pages artifact；其他 `main` commit 仍走完整 CI。

## 發布與回復

- 推送 `codex/<task>` 並建立 PR；CI 通過後才合併 `main`。
- GitHub Pages 僅部署 `main`，正式站與知識庫使用不同 workflow 及 concurrency group。
- 發布後確認首頁、`bonds.html`、兩個公開資料 asset 與 `integration-manifest.json` 可讀。
- 發布失敗時不修改知識庫；修正原 PR 或 `git revert <merge-commit>` 建立回復 PR。

## 上傳服務 rollout 與回復

穩定基準為 tag `rv-stable-before-upload-20260911`（commit `e26c23685cbec59a6d9e60f8dfab4122917a4a2d`、資料日 `2026-08-05`）。不得刪除歷史或 force-push `main`。

1. 先執行 `pnpm run deploy:worker:health`，記錄 Cloudflare version ID。此版本除 `/health` 外一律回覆未啟用。
2. 必須從公司電腦開啟 `/health` 並看到 `RV Upload Service OK`；若遭阻擋，立即停止，網站維持原狀。
3. 設定 preview Worker 的 encrypted secrets：`UPLOAD_PASSWORD`、`SESSION_SECRET`、`GITHUB_APP_ID`、`GITHUB_APP_INSTALLATION_ID`、`GITHUB_APP_PRIVATE_KEY`。GitHub App 只安裝在 `rv-dashboard`。
4. 以合成資料完成登入、PR、CI 測試；網站端 `assets/upload-config.json` 的 `enabled` 仍保持 `false`。
5. 用當期四份 Excel 比較瀏覽器結果與 `extract_excel_strict.py` 結果一致。
6. 最後才把 Worker `RV_UPLOAD_ENABLED` 與網站 config `enabled` 都切成 `true`，並經 PR 發布。

失敗時依範圍回復：

- PR 合併前：關閉 PR 並刪除該工作 branch，正式站不受影響。
- Worker：執行 `wrangler rollback <health-version-id>` 回到已記錄的 health-only 版本。
- 網站程式：從穩定 tag 建立 revert PR，原有 CI 通過後合併。
- 錯誤資料：建立只恢復前一版 `assets/rv-data.json` 的 PR；若也涉及程式錯誤，完整 revert 到穩定基準。
- App 或密碼疑似外洩：先將 Worker 發布端點設為停用，再撤銷 App installation 並輪替所有 secrets。

## 跨站契約

- manifest schema 目前為 v1。新增欄位可向後相容；刪除、改名或改型別需建立 `COORD-YYYYMMDD-NN` 成對 PR。
- 先讓讀取方同時接受新舊 schema，再讓輸出方切換，最後才能移除舊欄位。
- peer 無法連線時，本地建置與內容發布只警告；每日 health workflow 必須失敗並通知。
- `integration-manifest.json` 代表最後已部署版本；未合併工作以 Git branch／PR 為準。
