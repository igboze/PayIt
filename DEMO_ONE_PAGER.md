PayIT — Demo One-Pager

Overview

PayIT is a Telegram-native, non-custodial wallet that enables users and SMEs to hold USD/EUR stablecoins while transacting in local currency via integrated ON/OFF ramps.

Key demo highlights

- Onboarding: `/start` → choose Personal → create wallet → set PIN
- Send payment: Natural language "Send 3,000 NGN to Maria" → confirm with PIN → show receipt
- Invoice: Create invoice, preview PNG receipt, share link
- Admin: Export points, broadcast messages, toggle business mode

Quick demo steps (90-120 seconds)

1. Start the bot and show the `Welcome` message and points disclaimer.
2. Create a wallet (PIN flow) and show `users` table entry (optional local DB inspect).
3. Send a test command (natural language) and confirm automatic intent parsing.
4. Generate an invoice and show the PNG receipt preview (use `src/svg_render.js`).
5. Demonstrate voice note -> transcription -> payment intent flow.

Assets included

- Placeholder screenshots in `assets/` (onboarding, invoice, receipt)
- `PITCH.md` for marketing copy and social posts
- `CONTRIBUTING.md` for how to collaborate

Contact

For demo help, contact: team@payit.example (replace with real contact)
