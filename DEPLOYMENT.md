**Deployment Guide**

- **Build & publish container image (recommended)**: this repository includes a GitHub Actions workflow that builds and publishes a tagged image to GitHub Container Registry (GHCR) on pushes to `main`/`master`.

- **After the image is published**: use the image `ghcr.io/<your-org-or-user>/payit:latest` when creating a deployment on Railway (or another host). This avoids platform build agents and keeps deploys reproducible.

- **Railway / Container deployment settings**
  - Image: `ghcr.io/<org-or-user>/payit:latest`
  - Environment variables (minimum):
    - `TELEGRAM_BOT_TOKEN`
    - `ADMIN_TELEGRAM_IDS`
    - `OPENAI_TRANSCRIBE_API_KEY` (native OpenAI key for ASR)
    - `OPENAI_API_KEY` and `OPENAI_BASE_URL` (optional — for NVIDIA integrate LLMs)
    - `PAYIT_DB_PATH=/app/payit.db`
    - `INVOICE_FORWARDING_SECRET` and invoice-related settings
  - Bind a persistent volume to `/app/payit.db` (or use a managed DB) so wallets and users persist across restarts.

- **Webhook vs Polling**
  - Polling (`bot.launch()` with no `WEBHOOK_URL`) requires that only one running instance uses `getUpdates` for the bot token. If you deploy multiple replicas or another local bot is running, you will see `409 Conflict: terminated by other getUpdates request`.
  - For production, prefer webhooks and set `WEBHOOK_URL` to your public domain (or an http tunnel) so the bot uses webhook mode.

- **Local testing**
  - To run locally with a mounted DB file:
    ```powershell
    docker run -d --name payit-local -p 3000:3000 \
      -v C:\path\to\repo:/app \
      -v C:\path\to\repo\payit.db:/data/payit.db \
      --env-file C:\path\to\repo\.env \
      -e PAYIT_DB_PATH=/data/payit.db \
      ghcr.io/<org-or-user>/payit:latest
    docker logs -f payit-local
    ```

If you want, I can create a PR that customizes the workflow tag to match your GitHub org/repo name, or help push the first image and configure Railway. Tell me which provider (GHCR or Docker Hub) you prefer and whether you want me to stop the local bot instance now so we can finish testing locally.
