# Run PayIT locally in Docker (Windows PowerShell)
# Usage: Open PowerShell as Administrator and run: ./scripts/run-local.ps1

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
$EnvFile  = Join-Path $RepoRoot ".env"
$DbHost   = Join-Path $RepoRoot "payit.db"

Write-Host "Stopping any existing container..."
docker rm -f payit-local 2>$null | Out-Null

Write-Host "Ensuring DB file exists at $DbHost"
if (-Not (Test-Path $DbHost)) { New-Item -Path $DbHost -ItemType File | Out-Null }

Write-Host "Starting container using .env: $EnvFile"
docker run -d --name payit-local -p 3000:3000 `
  -v "${RepoRoot}:/app" `
  -v "${DbHost}:/data/payit.db" `
  --env-file "${EnvFile}" `
  -e PAYIT_DB_PATH=/data/payit.db `
  -e WEBHOOK_URL= `
  payit:local

Write-Host "Tailing logs (ctrl+c to exit)"
docker logs -f payit-local
