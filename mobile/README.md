# Proxim Mobile App (Android & iOS)

React Native (Expo SDK 58) client wired directly to the live Proxim backend at `https://payit-production.up.railway.app/api/app/v1`.

- **Zero dummy data**: every balance, FX rate, bank lookup, deposit address, card, invoice, KYC/KYB status, and transaction comes live from `/api/app/v1`.
- **Personal ↔ Business isolation**: top switcher calls `POST /accounts/switch` and attaches `X-Proxim-Account` on every request so deposits, payouts, cards, and schedules stay strictly separated.
- **Passkey + PIN approvals**: every money movement calls `/actions/:type/intent` → native Passkey assertion (`react-native-passkey`) + 4-digit PIN → `/actions/confirm`.
- **Live Railway Digital Asset Links**: `https://payit-production.up.railway.app/.well-known/assetlinks.json` is configured for `app.proxim.mobile` with release cert SHA-256 `3E:C0:9B:C5:94:45:5B:26:45:F5:77:7B:56:09:BE:44:60:42:DF:66:52:F2:B5:B6:12:20:8B:EB:EC:FF:DE:6F`.

## Automated Android APK Builds

### Option 1 — GitHub Actions (Automatic on every push to `master`)
Every push to `mobile/` triggers `.github/workflows/build-android-apk.yml` and uploads `Proxim-Android-APK` under **GitHub → Actions → Build Android APK**.

To have GitHub Actions output a **pre-signed** release APK automatically (matching Railway's live Passkey certificate), add these 4 secrets in **GitHub → Settings → Secrets and variables → Actions**:
- `ANDROID_KEYSTORE_BASE64`: Base64 of `C:\Users\Igboze\.proxim-signing\proxim-release.keystore`
- `ANDROID_KEYSTORE_PASSWORD`: `storePassword` from `C:\Users\Igboze\.proxim-signing\signing.properties`
- `ANDROID_KEY_ALIAS`: `proxim-release`
- `ANDROID_KEY_PASSWORD`: `keyPassword` from `C:\Users\Igboze\.proxim-signing\signing.properties`

Or, if downloading `app-release-unsigned.apk` from Actions, sign it locally in 2 seconds with:

```powershell
.\mobile\scripts\sign-apk.ps1 -InputApk path\to\app-release-unsigned.apk
```

### Option 2 — Expo EAS Cloud Build
```powershell
cd mobile
npx eas login
npx eas build -p android --profile preview
```
