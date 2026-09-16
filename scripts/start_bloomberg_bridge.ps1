param(
  [string]$SiteUrl = "https://larry890122.github.io/rv-dashboard/update.html"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $PSScriptRoot "bloomberg_bridge.py"
$python = Get-Command python -ErrorAction Stop

& $python.Source -c "import blpapi" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "找不到 Bloomberg Python API。請先執行：python -m pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi"
}

$token = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
$process = Start-Process -FilePath $python.Source -ArgumentList @("`"$bridge`"", "--token", $token) -WorkingDirectory $repoRoot -PassThru
try {
  Start-Sleep -Seconds 2
  Start-Process "$SiteUrl#bbg-token=$token"
  Write-Host "Bloomberg 診斷已啟動。請保留此視窗，完成後按 Ctrl+C 或關閉視窗。"
  Wait-Process -Id $process.Id
}
finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
}
