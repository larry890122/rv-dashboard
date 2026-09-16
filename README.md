# RV Dashboard

獨立的公開 RV 相對價值網站。正式網址：<https://larry890122.github.io/rv-dashboard/>。

```sh
python3 publish.py --build-only
python3 -m unittest discover -s tests -v
pnpm run test:model
pnpm run test:worker
pnpm run check:worker
python3 -m http.server 8766 --directory public
pnpm run test:browser -- http://127.0.0.1:8766/
```

首頁保留既有 RV 圖表；`bonds.html` 提供「單券相對價值比較表」，包括 Yield／OAS 點位、穩健 LOWESS 信評曲線、篩選與排名表。

原始 Excel、PPT 與私人稽核資料必須留在 Review workspace（網站 repo 之外），不得加入本 repository。LUAC 公開端只保存通過嚴格驗證的 `assets/luac-bonds.json`。

網站的「更新資料」頁會直接在瀏覽器記憶體中解析 RV 四份 Excel 或獨立的 LUAC 純值 workbook，只把通過嚴格驗證的公開 JSON 傳給更新服務。兩種資料有各自的發布開關、branch、label 與單檔 diff 防護。

完整維運流程見 `SITE_OPERATIONS.md`。
