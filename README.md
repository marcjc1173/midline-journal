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

- **Daily Writing & Photos**: Exact date and time tracking (including backdating and multiple entries per day), direct mobile camera capture (**Take Photo**), drag-and-drop uploads with automatic thumbnails and full-screen lightbox.
- **Question of the Day**: Consistent daily reflection prompt across 7 grounded themes (*Carrying Weight*, *Next Chapter*, *Health & Energy*, *Relationships*, *Perspective*, *Small Wins*, *Values & Legacy*), with one-click shuffle and custom prompt management.
- **Back on This Day**: Automatically surfaces entries from the same date in previous years (plus a one-month throwback while your journal is new) so you can see how far you've come.
- **Calendar View**: Monthly calendar where days with entries stand out visually with mood and photo indicators. Click any day to read or add entries.
- **Mood, Energy, Search & Tags**: Plain-spoken 1-click mood check-in (*Good, Steady, Grateful, Stressed, Heavy, Low*), optional 1–5 energy level, full-text search, and tag filtering.
- **Private Lock, Auto-Lock & Phone Passkeys**: Single-user password/PIN lock, **WebAuthn Passkey** support (Face ID, Touch ID, fingerprint), configurable **Auto-Lock** (on close or inactivity timeout), and **Draft Auto-Save** so you never lose what you're writing.
- **Warm & Grounded Themes + PWA**: Switch between **Dark Charcoal** and **Warm Paper** modes, and install as an app on your phone or desktop.

---

## Quick Start (Docker — Recommended)

```bash
git clone https://github.com/marcjc1173/midline-journal.git
cd midline-journal
docker compose up -d --build
```

Then open `http://localhost:3001` (or `http://<your-server-ip>:3001`) to set your password/PIN and start writing.

### Backups (Local & Google Drive via `rclone`)
Everything—your SQLite database (`midline.db`) and all uploaded photos—lives inside `./data`. Back up that single folder and you have your entire journal.

Midline also includes [`scripts/backup.sh`](./scripts/backup.sh), which takes a safe live SQLite snapshot (so the database is never copied mid-write) and syncs it along with your photos to **Google Drive** (or Dropbox, OneDrive, S3, Backblaze B2) using [`rclone`](https://rclone.org/):

1. Install `rclone` (`sudo apt install rclone` or `brew install rclone`) and link Google Drive:
   ```bash
   rclone config
   # Choose: n (New remote) → Name: gdrive → Storage: drive (Google Drive)
   ```
   *(Optional: wrap `gdrive` in an `rclone crypt` remote if you want end-to-end encrypted backups before upload.)*
2. Run a backup anytime:
   ```bash
   RCLONE_REMOTE="gdrive:MidlineBackup" ./scripts/backup.sh
   ```
3. Automate nightly backups with a `cron` job or `systemd` user timer:
   ```bash
   # Example crontab entry (2:00 AM daily):
   0 2 * * * RCLONE_REMOTE="gdrive:MidlineBackup" /path/to/midline-journal/scripts/backup.sh
   ```

### Restoring from a Backup
Midline includes [`scripts/restore.sh`](./scripts/restore.sh) to safely restore your database and photos from either `rclone` (Google Drive, etc.) or a local backup folder. It verifies SQLite integrity before swapping files, saves a timestamped safety copy of your current `./data` directory, and clears stale WAL files automatically.

1. **Stop Midline first** (never overwrite a live SQLite database while the server is running):
   ```bash
   # Docker:
   docker compose down
   # Or systemd user service:
   systemctl --user stop midline
   ```
2. **Run the restore script:**
   ```bash
   # From rclone / Google Drive:
   RCLONE_REMOTE="gdrive:MidlineBackup" ./scripts/restore.sh

   # Or from a local backup folder:
   ./scripts/restore.sh --from /path/to/backup-folder
   ```
3. **Start Midline again:**
   ```bash
   # Docker:
   docker compose up -d
   # Or systemd user service:
   systemctl --user start midline
   ```

*(Manual restore without the script: stop Midline, remove any `midline.db-wal` and `midline.db-shm` files in `./data`, copy your backed-up `midline.db` and `uploads/` folder into `./data`, then start Midline again. Missing thumbnails in `thumbs/` are handled automatically by falling back to the original photos.)*

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
