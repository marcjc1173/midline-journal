# Midline

**A quiet, private, self-hosted daily journal built for men navigating midlife (45–60).**

🌐 [midlinejournal.com](https://midlinejournal.com) · [![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-d9923b?style=flat&logo=buy-me-a-coffee&logoColor=141517)](https://buymeacoffee.com/marcjc1173)

---

## Why Midline Exists

Midlife hits differently than people talk about. Somewhere between 45 and 60, a lot of men find themselves carrying a heavy mix of things at once—work and purpose shifting, bodies changing, kids growing up or leaving, parents aging, friendships quietly fading, and the feeling that you're supposed to just keep your head down and push through it.

Writing helps. Getting what's looping in your head onto a page—without performing for anyone, without a subscription, and without a third-party company storing your most honest thoughts—takes some of the weight off.

Most journaling apps are either cloud subscriptions, generic blank pages, or filled with prompts that don't fit where you actually are in life. **Midline** is built to be the opposite:

- **100% self-hosted & private** — your entries and photos live in a single `./data` folder on your own machine or home server.
- **Grounded, midlife-focused daily questions** — 64+ prompts written specifically for men in their 45–60s, for the days you sit down and don't know where to start.
- **Low friction** — open it, write two sentences or two pages, drop in a photo, check in on your mood/energy if you want, and close it.

---

## Screenshots

### Today — Question of the Day, Entries with Photos & Back on This Day
![Midline Today View](./docs/screenshots/today.png)

### Calendar View — Past Entries & Photo Indicators at a Glance
![Midline Calendar View](./docs/screenshots/calendar.png)

---

## Features

- **Daily Writing & Photos**: Exact date and time tracking (including backdating and multiple entries per day), direct mobile camera capture (**Take Photo**), drag-and-drop uploads (up to **10 photos per entry**, 15 MB max per photo) with automatic thumbnails and full-screen lightbox.
- **Question of the Day**: Consistent daily reflection prompt across 7 grounded themes (*Carrying Weight*, *Next Chapter*, *Health & Energy*, *Relationships*, *Perspective*, *Small Wins*, *Values & Legacy*), with one-click shuffle and custom prompt management.
- **Back on This Day**: Automatically surfaces entries from the same date in previous years (plus a one-month throwback while your journal is new) so you can see how far you've come.
- **Calendar View**: Monthly calendar where days with entries stand out visually with mood and photo indicators. Click any day to read or add entries.
- **Mood, Energy, Search & Tags**: Plain-spoken 1-click mood check-in (*Good, Steady, Grateful, Stressed, Heavy, Low*), optional 1–5 energy level, full-text search, and tag filtering.
- **Private Lock, Auto-Lock & Phone Passkeys**: Single-user password/PIN lock, **WebAuthn Passkey** support (Face ID, Touch ID, fingerprint), configurable **Auto-Lock** (on close or inactivity timeout), and **Draft Auto-Save** so you never lose what you're writing.
- **Built-In Encrypted Backups & Google Drive Sync**: One-click full backup downloads (`.tar.gz` or AES-256-GCM encrypted `.tar.gz.enc`), live in-app restore from Settings or the first-run setup screen, and automatic scheduled encrypted cloud backups to **Google Drive** with retention pruning.
- **Warm & Grounded Themes + PWA**: Switch between **Dark Charcoal** and **Warm Paper** modes, and install as an app on your phone or desktop.

---

## Quick Start (Docker — Recommended)

No `git` clone required—just download `docker-compose.yml` into a folder and start the container:

```bash
mkdir midline && cd midline
curl -O https://raw.githubusercontent.com/marcjc1173/midline-journal/main/docker-compose.yml
docker compose up -d
```

Then open `http://localhost:3001` (or `http://<your-server-ip>:3001`) to set your password/PIN and start writing.

### Updating to the Latest Version

```bash
docker compose pull
docker compose up -d
```

<details>
<summary>Alternative: Build the Docker image from source</summary>

```bash
git clone https://github.com/marcjc1173/midline-journal.git
cd midline-journal
docker build -t ghcr.io/marcjc1173/midline-journal:latest .
docker compose up -d
```

</details>

### Backups & Restore (Built Into the App)
Everything—your SQLite database (`midline.db`) and all uploaded photos—lives inside `./data`, and Midline includes full **Backup & Restore** directly in **Settings** (no external scripts required):

1. **Manual Download & Restore (with optional AES-256-GCM Encryption)**
   - In **Settings → Backup & Restore**, click **Download Backup** to save a live, consistent snapshot (`.tar.gz`) containing your database and all photos.
   - Check **Encrypt download with passphrase** to encrypt the archive with **AES-256-GCM** (`.tar.gz.enc`) before saving it anywhere (cloud drive, USB stick, etc.).
   - To restore, upload any `.tar.gz`, `.tar.gz.enc`, or `midline.db` file in **Settings → Backup & Restore** — or click **Restore from Backup File** directly on the **first-run setup screen** when moving to a brand-new server. Midline verifies SQLite integrity before swapping, saves an automatic timestamped safety copy in `./data/.pre-restore-*`, and restores live without needing to stop the server.

2. **Google Drive Cloud Sync (Encrypted & Scheduled)**
   - In **Settings → Google Drive Cloud Sync**, connect your Google Drive using the least-privilege `drive.file` scope (Midline can only access files and folders it creates itself).
   - Expand the built-in **One-time Google Cloud setup guide** in Settings to copy your exact **Authorized Redirect URI**, paste your Google OAuth Client ID/Secret, and set a **Backup Encryption Passphrase**.
   - Every cloud backup is encrypted with **AES-256-GCM** before leaving your server. Run **Back Up Now** anytime, enable **Daily** or **Weekly** automatic backups with configurable retention (keep last 3, 7, 14, or 30), and **Restore** or **Delete** cloud snapshots directly from Settings.
   - *(Keep your backup encryption passphrase in a password manager — you'll need it to decrypt cloud backups if you ever restore onto a new machine.)*

<details>
<summary>Alternative: CLI Backup & Restore Scripts (<code>rclone</code> / <code>cron</code>)</summary>

Midline also includes [`scripts/backup.sh`](./scripts/backup.sh) and [`scripts/restore.sh`](./scripts/restore.sh) if you prefer scripted backups via [`rclone`](https://rclone.org/) (Google Drive, Dropbox, OneDrive, S3, Backblaze B2):

1. Install `rclone` (`sudo apt install rclone` or `brew install rclone`) and link your remote (`rclone config`).
2. Run a backup anytime (or schedule via `cron`):
   ```bash
   RCLONE_REMOTE="gdrive:MidlineBackup" ./scripts/backup.sh
   ```
3. To restore via CLI, stop Midline first (`docker compose down` or `systemctl --user stop midline`), then run:
   ```bash
   # From rclone:
   RCLONE_REMOTE="gdrive:MidlineBackup" ./scripts/restore.sh

   # Or from a local backup folder:
   ./scripts/restore.sh --from /path/to/backup-folder
   ```
4. Start Midline again (`docker compose up -d` or `systemctl --user start midline`).

</details>

### Enabling Phone Passkeys (Face ID / Touch ID / Fingerprint)
Browsers require **HTTPS + a hostname** to use Passkeys outside `localhost`. Two easy ways to enable HTTPS for your self-hosted instance:

1. **Tailscale Serve (easiest private setup):**
   ```bash
   tailscale serve --bg 3001
   ```
   This gives you a private `https://<your-machine>.<your-tailnet>.ts.net` URL reachable only on your devices. Passkeys will work automatically.

2. **Reverse Proxy (Caddy / Nginx):**
   Proxy your domain to port `3001` with HTTPS, and optionally set `RP_ID` and `ORIGIN` in `docker-compose.yml`:
   ```yaml
   environment:
     - RP_ID=journal.midlinejournal.com
     - ORIGIN=https://journal.midlinejournal.com
   ```

---

## Local Development (Without Docker)

Requires **Node.js 22+**.

```bash
npm run install:all
npm run build
npm start
```

Or run the backend and frontend dev servers with hot reload:
```bash
npm run dev:server
npm run dev:client
```

---

## Contributing

Contributions are welcome—especially **new midlife reflection prompts** (see `server/src/prompts.ts`), UI polish, and export/backup features. Keep the tone honest, grounded, and practical.

## Support

Midline is free and open-source. If it's been helpful to you and you'd like to support its development, you can [buy me a coffee](https://buymeacoffee.com/marcjc1173).

## License

[MIT](./LICENSE)
