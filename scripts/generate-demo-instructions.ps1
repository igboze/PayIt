# Instructions to capture demo screenshots and create a short demo video for PayIT

Write-up: follow these steps on a Windows machine where you run the bot locally.

1. Start the local container:

```powershell
./scripts/run-local.ps1
```

2. Open Telegram (desktop or mobile) and interact with the bot. Capture these moments:
   - Onboarding flow (`/start`) — save as `assets/screenshot_onboarding.png`
   - Send payment flow — save as `assets/screenshot_send_payment.png`
   - Invoice preview — save as `assets/screenshot_invoice_preview.png`
   - Admin menu — save as `assets/screenshot_admin_menu.png`

3. For screenshots use native OS screenshot tools or Telegram Desktop's built-in message screenshot. Recommended size for video stills: 1280x720.

4. Assemble a 1-2 minute demo video using any simple editor (QuickTime, OBS, or Clipchamp). Script based on `PITCH.md`.

Optional: convert the placeholder SVGs to PNG using ImageMagick if installed:

```powershell
magick assets/screenshot_onboarding.svg assets/screenshot_onboarding.png
```

If you want, I can generate sample PNGs from the SVG placeholders if ImageMagick is available in this environment. Run: `magick -version` to check.
