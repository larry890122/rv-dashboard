# RV upload Worker

This Worker accepts only the validated public JSON snapshot. It never receives an
Excel file, filename, local path, or source-file hash.

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

1. Deploy with `RV_UPLOAD_ENABLED=false`; record the returned version ID.
2. Verify `/health` from the company network. It must say `RV Upload Service OK`.
3. Test a preview deployment with synthetic workbooks.
4. Set the Worker URL in `assets/upload-config.json`, while keeping `enabled=false`.
5. After the comparison and browser tests pass, set both the Worker variable and the
   site config to `true`.

If a full Worker deployment fails, roll back to the recorded health-only version.
Website rollback must use a PR reverting to tag
`rv-stable-before-upload-20260911`; never force-push `main`.
