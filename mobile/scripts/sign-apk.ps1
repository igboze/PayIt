param(
  [string]$InputApk = "",
  [string]$OutputApk = "$PSScriptRoot\..\build\Proxim-release.apk"
)

$ErrorActionPreference = "Stop"

# Auto-locate the NEWEST downloaded artifact zip or unsigned APK if -InputApk is omitted or missing
if (-not $InputApk -or -not (Test-Path $InputApk)) {
  $downloads = Join-Path $env:USERPROFILE "Downloads"
  $foundFiles = @()
  if (Test-Path $downloads) {
    $foundFiles += Get-ChildItem -Path $downloads -Filter "Proxim-Android-APK*.zip" -File -ErrorAction SilentlyContinue
    $foundFiles += Get-ChildItem -Path $downloads -Filter "app-release*.apk" -File -ErrorAction SilentlyContinue
  }
  $newest = $foundFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1

  if ($newest) {
    $InputApk = $newest.FullName
    Write-Host "Found newest input artifact ($($newest.LastWriteTime)): $InputApk" -ForegroundColor Cyan
  } else {
    Write-Host ""
    Write-Host "No downloaded APK found in $downloads." -ForegroundColor Yellow
    Write-Host "1. Open: https://github.com/igboze/PayIt/actions/workflows/build-android-apk.yml" -ForegroundColor Cyan
    Write-Host "2. Scroll to 'Artifacts' at the bottom and click 'Proxim-Android-APK' to download Proxim-Android-APK.zip." -ForegroundColor Cyan
    Write-Host "3. Re-run: .\mobile\scripts\sign-apk.ps1" -ForegroundColor Green
    Write-Host ""
    exit 1
  }
}

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

$tempExtractDir = $null
$sourceApk = $InputApk

try {
  # Automatically unzip Proxim-Android-APK.zip if a zip archive was passed/found
  if ([IO.Path]::GetExtension($InputApk).ToLowerInvariant() -eq ".zip") {
    $tempExtractDir = Join-Path $env:TEMP ("proxim-apk-unzip-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tempExtractDir | Out-Null
    Expand-Archive -Path $InputApk -DestinationPath $tempExtractDir -Force
    $apkFile = Get-ChildItem $tempExtractDir -Recurse -Filter "*.apk" | Select-Object -First 1
    if (-not $apkFile) { throw "No .apk file found inside $InputApk" }
    $sourceApk = $apkFile.FullName
    Write-Host "Extracted APK: $($apkFile.Name)"
  }

  $outDir = Split-Path -Parent $OutputApk
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $alignedApk = Join-Path $env:TEMP ("proxim-aligned-" + [guid]::NewGuid().ToString("N") + ".apk")

  try {
    & $zipalign -f -p 4 $sourceApk $alignedApk
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
    $aapt2 = Join-Path $buildTools.FullName "aapt2.exe"
    if (Test-Path $aapt2) {
      Write-Host "=== APK VERSION & OTA CONFIG ==="
      & $aapt2 dump xmltree $OutputApk --file AndroidManifest.xml |
        Select-String -Pattern 'versionCode|versionName|expo\.modules\.updates\.(ENABLED|EXPO_UPDATE_URL)' -Context 0,1 |
        ForEach-Object { $_.Line.Trim(); if ($_.Context.PostContext) { "  " + $_.Context.PostContext[0].Trim() } }
    }
    Write-Host ""
    Write-Host "SIGNED APK READY TO INSTALL ON ANDROID:" -ForegroundColor Green
    Write-Host (Resolve-Path $OutputApk).Path -ForegroundColor White
  } finally {
    if (Test-Path $alignedApk) { Remove-Item $alignedApk -Force }
  }
} finally {
  if ($tempExtractDir -and (Test-Path $tempExtractDir)) { Remove-Item $tempExtractDir -Recurse -Force }
}
