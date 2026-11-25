param(
  [Parameter(Mandatory = $true)]
  [string]$InputApk,
  [string]$OutputApk = "$PSScriptRoot\..\build\Proxim-release.apk"
)

$ErrorActionPreference = "Stop"

$signDir = Join-Path $env:USERPROFILE ".proxim-signing"
$propsPath = Join-Path $signDir "signing.properties"
if (-not (Test-Path $propsPath)) {
  throw "Release signing config not found at $propsPath"
}

$props = @{}
Get-Content $propsPath | ForEach-Object {
  if ($_ -match "^([^=]+)=(.*)$") { $props[$matches[1].Trim()] = $matches[2].Trim() }
}

$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$buildTools = Get-ChildItem (Join-Path $sdkRoot "build-tools") -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1

if (-not $buildTools) {
  throw "Android build-tools not found under $sdkRoot\build-tools. Run: android sdk install build-tools/36.0.0"
}

$zipalign = Join-Path $buildTools.FullName "zipalign.exe"
$apksigner = Join-Path $buildTools.FullName "apksigner.bat"

$outDir = Split-Path -Parent $OutputApk
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$alignedApk = Join-Path $env:TEMP ("proxim-aligned-" + [guid]::NewGuid().ToString("N") + ".apk")

try {
  & $zipalign -f -p 4 $InputApk $alignedApk
  if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

  & $apksigner sign `
    --ks $props["storeFile"] `
    --ks-key-alias $props["keyAlias"] `
    --ks-pass ("pass:" + $props["storePassword"]) `
    --key-pass ("pass:" + $props["keyPassword"]) `
    --out $OutputApk `
    $alignedApk
  if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

  Write-Host "=== VERIFYING SIGNATURE ==="
  & $apksigner verify --print-certs $OutputApk
  Write-Host "SIGNED_APK_READY: $OutputApk"
} finally {
  if (Test-Path $alignedApk) { Remove-Item $alignedApk -Force }
}
