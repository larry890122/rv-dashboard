# RV upload Worker

This Worker accepts only validated public JSON snapshots. It never receives an
Excel file, filename, local path, or source-file hash. RV uses `POST /publish` and
`GET /status/:id`; LUAC uses `POST /publish/luac` (4 MiB maximum) and
`GET /status/luac/:id`.

Required encrypted Worker secrets:

- `UPLOAD_PASSWORD`
- `SESSION_SECRET` (a random value of at least 32 bytes)
- `GITHUB_APP_ID`
- `GITHUB_APP_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY`

The GitHub App must be installed only on `rv-dashboard` with repository permissions
for Contents (read/write), Pull requests (read/write), and Issues (read/write).
Create repository variable `RV_UPLOAD_APP_LOGIN` with the App bot login (for example
`name[bot]`). The CI auto-merge gate remains closed when the variable is absent.

Rollout order:

1. Deploy with `RV_UPLOAD_ENABLED=false` and `LUAC_UPLOAD_ENABLED=false`; record the returned version ID.
2. Verify `/health` from the company network. It must say `RV Upload Service OK`.
3. Test a preview deployment with synthetic workbooks.
4. Set the Worker URL in `assets/upload-config.json`, while keeping `enabled=false`.
5. Enable RV and LUAC independently. LUAC requires 8,870 expected records, 3 expected
   Yield anomalies, browser/Python parity, and the separate site `luac_enabled` flag.

If a full Worker deployment fails, roll back to the recorded health-only version.
Website rollback must use a PR reverting to tag
`rv-stable-before-upload-20260911`; never force-push `main`.

The active health-only rollback target is recorded in `health-baseline.json`. Do not
replace it with a full Worker version. Update `company_network_check` only after the
same `/health` URL has been opened successfully from the company computer.

Preview versions must set `PUBLISH_MODE=preview`. They create `preview/rv-data-*`
branches with the `rv-data-preview` label, so the production auto-merge conditions
cannot match. They also target `PREVIEW_BASE_REF`, never `main`. Production requires
the separate `PUBLISH_MODE=production` setting and always targets `main`.
