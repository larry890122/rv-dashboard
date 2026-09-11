# RV Dashboard 維運手冊

## 邊界與來源

- 本 repository 只負責 `https://larry890122.github.io/rv-dashboard/`。
- `ib-knowledge-base` 是獨立 peer；本 repo 不得修改或發布它。
- 私人來源位於 Review workspace 的 `RV/`。抽取程式只讀來源，僅將通過驗證的 `assets/rv-data.json` 寫入本 repo。
- 稽核 JSON 必須寫到 repo 外；Excel、PPT、PDF、絕對路徑與來源雜湊不得公開。

## 每次開始工作

1. `git fetch origin`，從 `origin/main` 建立 `codex/<task>` branch 或 Codex worktree。
2. 完整閱讀本文件與 `AGENTS.MD`。
3. 執行 `python3 peer_status.py`，記錄知識庫最後穩定版本；peer 暫時離線是警告，不代表可修改對方 repo。
4. 確認 `git status` 沒有不屬於本任務的變更。

## 更新資料

```sh
python3 scripts/extract_rv.py \
  --workbooks <Spread.xlsx> <10Y.xlsx> <30Y.xlsx> <10s30s.xlsx> \
  --deck <reviewed-v2-deck.pptx> \
  --date YYYY-MM-DD \
  --slide-date YYYY-MM-DD \
  --audit ../../rv-audits/YYYY-MM-DD.json
```

`--slide-date` 是人工核對後的資料日期，不得用檔案建立或修改時間代替。只要投影片與 Excel 差異超過容許值，抽取器會停止替換公開快照。

## 建置與驗證

```sh
python3 publish.py --build-only
python3 -m unittest discover -s tests -v
python3 peer_status.py
python3 -m http.server 8766 --directory public
pnpm run test:browser -- http://127.0.0.1:8766/
```

PR 必須通過資料 schema、460 個摘要值、公開資料防洩漏、連結、manifest 與桌面／平板／手機 Playwright 測試。

## 發布與回復

- 推送 `codex/<task>` 並建立 PR；CI 通過後才合併 `main`。
- GitHub Pages 僅部署 `main`，正式站與知識庫使用不同 workflow 及 concurrency group。
- 發布後確認首頁、`assets/rv-data.json` 與 `integration-manifest.json` 可讀。
- 發布失敗時不修改知識庫；修正原 PR 或 `git revert <merge-commit>` 建立回復 PR。

## 跨站契約

- manifest schema 目前為 v1。新增欄位可向後相容；刪除、改名或改型別需建立 `COORD-YYYYMMDD-NN` 成對 PR。
- 先讓讀取方同時接受新舊 schema，再讓輸出方切換，最後才能移除舊欄位。
- peer 無法連線時，本地建置與內容發布只警告；每日 health workflow 必須失敗並通知。
- `integration-manifest.json` 代表最後已部署版本；未合併工作以 Git branch／PR 為準。
