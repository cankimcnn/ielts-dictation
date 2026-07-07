# Single-server deployment

This application can run on one Linux server and persist progress in SQLite.

## Files and data

- Application: `/opt/ielts-dictation`
- Database: `/var/lib/ielts-dictation/dictation.db`
- Backups: `/var/lib/ielts-dictation/backups`
- Service account: `ielts`

The `data` directory must be on persistent storage and included in server backups.

## Install

```bash
sudo useradd --system --home /var/lib/ielts-dictation --shell /usr/sbin/nologin ielts
sudo mkdir -p /opt/ielts-dictation /var/lib/ielts-dictation
sudo chown -R ielts:ielts /opt/ielts-dictation /var/lib/ielts-dictation
```

Copy the contents of this directory to `/opt/ielts-dictation`, then install the service:

```bash
sudo cp deploy/ielts-dictation.service.example /etc/systemd/system/ielts-dictation.service
sudo systemctl daemon-reload
sudo systemctl enable --now ielts-dictation
sudo systemctl status ielts-dictation
```

Replace `DICTATION_TOKEN` in the service file with a long random value before starting it.

## HTTPS proxy

Expose the service through HTTPS rather than opening port 4173 publicly. Example Caddy configuration:

```caddyfile
ielts.example.com {
    reverse_proxy 127.0.0.1:4173
}
```

On the first visit, open:

```text
https://ielts.example.com/?token=YOUR_TOKEN
```

The browser stores the token locally and uses it for subsequent progress API requests.

## Verification

```bash
curl http://127.0.0.1:4173/api/health
sudo sqlite3 /var/lib/ielts-dictation/dictation.db '.tables'
```

Expected tables: `app_state`, `word_progress`, and `attempts`.
