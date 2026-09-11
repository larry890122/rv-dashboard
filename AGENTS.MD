# RV 網站協作規則

1. 開始網站工作前，完整閱讀 `SITE_OPERATIONS.md`，再執行 `python3 peer_status.py`。
2. 本 repository 只擁有 `rv-dashboard`；不得修改、commit 或 deploy `ib-knowledge-base`。
3. 原始 Excel、PPT、稽核檔與絕對路徑不得加入 Git 或公開輸出。
4. 修改使用 `codex/<task>` branch 或 worktree；測試通過後以 PR 合併 `main`。
5. 跨站介面修改使用共同變更編號建立成對 PR，舊介面需保留到兩邊完成切換。
6. `integration-manifest.json` 只代表最後一個已驗證並發布的穩定版本；進行中工作以 branch／PR 為準。
