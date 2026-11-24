# Proxim Mobile App (Android & iOS)

React Native (Expo SDK 58) client wired directly to the live Proxim backend at `https://payit-production.up.railway.app/api/app/v1`.

- **Zero dummy data**: every balance, FX rate, bank lookup, deposit address, card, invoice, and transaction comes live from `/api/app/v1`.
- **Personal ↔ Business isolation**: top switcher calls `POST /accounts/switch` and attaches `X-Proxim-Account` on every request so deposits, payouts, cards, and schedules stay strictly separated.
- **Passkey + PIN approvals**: every money movement calls `/actions/:type/intent` → native Passkey assertion (`react-native-passkey`) + 4-digit PIN → `/actions/confirm`.

## Build an Installable Android `.apk` (No Android Studio Needed)

Because Passkeys use native Android Credential Manager, test using an EAS APK build rather than Expo Go:

```bash
cd mobile
npm install
npx eas login
npx eas build -p android --profile preview
```

When the cloud build finishes (~5–10 min), EAS gives you a **QR code and direct `.apk` download link** to install on your Android phone.

## Link Your APK Signing Certificate for Android Passkeys (Railway)

After your first EAS build creates the Android keystore, print the signing certificate SHA-256:

```bash
cd mobile
npx eas credentials -p android
```

1. Copy the **SHA-256 Fingerprint** (colon-separated hex, e.g. `AA:BB:CC:...`) into Railway as `APP_ANDROID_CERT_SHA256`.
2. Convert that hex fingerprint into Android's `apk-key-hash` base64url string:

```bash
node -e "const hex='AA:BB:CC:...'.replace(/:/g,''); console.log('android:apk-key-hash:' + Buffer.from(hex,'hex').toString('base64url'));"
```

3. Set Railway `APP_ORIGINS` to:

```text
https://payit-production.up.railway.app,android:apk-key-hash:<output-from-step-2>
```

4. Redeploy Railway and verify `https://payit-production.up.railway.app/.well-known/assetlinks.json` returns your package `app.proxim.mobile` and fingerprint.
