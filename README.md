# RV Dashboard

獨立的公開 RV 相對價值網站。正式網址：<https://larry890122.github.io/rv-dashboard/>。

```sh
python3 publish.py --build-only
python3 -m unittest discover -s tests -v
python3 -m http.server 8766 --directory public
pnpm run test:browser -- http://127.0.0.1:8766/
```

原始 Excel、PPT 與私人稽核資料必須留在 Review workspace（網站 repo 之外），不得加入本 repository。

完整維運流程見 `SITE_OPERATIONS.md`。
