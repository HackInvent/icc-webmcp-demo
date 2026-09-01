# Deployment without Docker or systemd

Paris ICC is a Node.js application served behind a same-origin Nginx reverse
proxy. It uses an embedded SQLite file for durable demonstration state. It does
not require Docker, Compose, systemd, PostgreSQL, H2, or another database daemon.

## Requirements

- Ubuntu or another supported Linux host;
- Node.js 20 or newer and npm; Node.js 22 LTS is recommended;
- Nginx with HTTPS for the public hostname;
- an OpenAI API key when model-assisted analysis is enabled;
- an optional IDFM PRIM key only for live passenger-information evidence.

Install exactly the locked dependencies, including `tsx` and `sql.js`:

```bash
npm ci
```

## Runtime command

The production process serves the static build, authenticates the shared access code,
hosts the operations API/SSE stream, owns the railway clock, persists SQLite,
runs the OpenAI agent protocol, and optionally proxies PRIM.

```bash
npm run build
npm run serve
```

`npm run serve` expands to:

```bash
node --import tsx server/index.mjs --config config/server.local.json
```

Start it from the repository root. The server handles `SIGINT` and `SIGTERM` and
flushes queued operations before closing the SQLite repository.

## Private configuration

Create the ignored file interactively:

```bash
npm run configure:server
```

Or copy the public template:

```bash
cp config/server.example.json config/server.local.json
chmod 600 config/server.local.json
```

Unknown properties and invalid ranges are rejected. The relevant deployment
shape is:

```json
{
  "application": {
    "publicOrigin": "https://paris-icc-demo.hackinvent.com"
  },
  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "trustProxy": true,
    "distDirectory": "../dist"
  },
  "auth": {
    "secureCookies": true
  },
  "openai": {
    "model": "gpt-5.6-terra",
    "reasoningEffort": "low",
    "allowedModels": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
  },
  "agent": {
    "incidentInstructions": [
      {
        "type": "infrastructure",
        "label": "Infrastructure",
        "instruction": "Prioritise the exact failed asset and protected movement scope..."
      }
    ],
    "logMaxEntries": 1000
  },
  "storage": {
    "databasePath": "../state/paris-icc.sqlite",
    "agentRuntimePath": "../state/agent-runtime.json",
    "tickIntervalMs": 1000
  }
}
```

This is only an excerpt. The packaged example enables every current model that
supports the complete Paris ICC Responses API, function-tool, and
structured-output workflow. The server publishes each model's valid effort
values to the Configuration modal and rejects invalid model/effort pairs. Keep
the complete `auth`, `openai`, `agent`, and `prim` sections from the template.
Paths are resolved relative to the JSON file, not the
current shell. For the private external deployment kit, use
`state/paris-icc.sqlite` so the database remains beside that kit and outside Git.

The configurator writes the JSON with mode `0600`. The repository creates the
SQLite file with mode `0600`; the agent model-and-effort override and bounded
metadata-only execution log are atomically persisted in `agentRuntimePath` with
mode `0600`.
Their parent directory should be mode `0700`. Never put a secret in a `VITE_`
variable.

Never commit or publish:

- `config/server.local.json`, `.env`, API keys, session secrets, or access codes;
- session cookies, server logs, PID files, or private deployment scripts;
- runtime SQLite files, `agent-runtime.json`, or their temporary/WAL/SHM companions;
- backups containing operational or personal data.

## Validate and run

```bash
npm run check:server
npm run check
npm test
npm run build
npm run serve
```

In another terminal:

```bash
curl --fail http://127.0.0.1:8787/healthz
```

A healthy response includes `"status":"ok"` and
`"storage":{"ready":true,"engine":"sqlite"}`.

## Nginx same-origin proxy and SSE

The frontend and every `/api/*` route must use one HTTPS origin. SSE must not be
buffered. Place the exact events location before the generic location:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name paris-icc-demo.hackinvent.com;

    server_tokens off;
    client_max_body_size 256k;

    location = /api/operations/events {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_send_timeout 65s;
        add_header X-Accel-Buffering no always;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 65s;
        proxy_send_timeout 65s;
    }
}
```

Validate and reload through the host's normal workflow:

```bash
sudo nginx -t
sudo nginx -s reload
```

If Certbot already modified the installed virtual host, merge the dedicated SSE
location instead of overwriting the TLS configuration.

## SQLite lifecycle

The database holds independent workspaces keyed by authenticated session ID,
complete reset baselines, schedule state, procedure progress, current-shift
incident/action logs, autosaved report drafts, ordered events, and idempotent command
receipts. Refreshing the page preserves state. Restarting the
server preserves state when all three remain unchanged:

1. the SQLite file;
2. `auth.sessionSecret`;
3. the browser's still-valid signed cookie.

A new browser session intentionally starts a separate workspace. Telemetry-only
movement is checkpointed at most every five seconds and flushed on graceful stop;
decisions, procedure steps, normalized shift entries, report freezes, events, and
command receipts are written immediately. Report text is persisted after its short
browser autosave debounce. A `0600` sidecar lock prevents two Node processes from writing
the same embedded database.

For an exact backup:

```bash
# Stop the Paris ICC Node process first.
cp state/paris-icc.sqlite state/paris-icc.sqlite.backup
chmod 600 state/paris-icc.sqlite.backup
```

Restoration is the reverse operation while the process is stopped. Do not edit
the database manually. A schema newer than the application is rejected rather
than silently reset.

## Updating

Stop the Paris ICC Node process, retain the private JSON and SQLite file, then run:

```bash
npm ci
npm run check:server
npm run check
npm test
npm run build
npm run serve
```

Do not replace the database with a fresh file during normal deployment.

## Troubleshooting

### `The request origin is not allowed`

`application.publicOrigin` must exactly match scheme, hostname, and explicit
non-default port. Behind Nginx, set `server.trustProxy: true` and forward Host and
protocol as shown above.

### The page loads but state does not update

Check `/healthz`, authenticate, then inspect the Network panel for the
`/api/operations/events` request. It must remain open as `text/event-stream`.
Confirm the dedicated Nginx location has `proxy_buffering off` and a long read
timeout.

### Report or operations log disappears after reload

The report and current-shift log use the same authenticated SQLite workspace as
railway state. Confirm that the signed session cookie is unchanged and the SSE
snapshot contains `shift`. A different browser session intentionally receives a
separate workspace. Do not confuse the global **Reset**, which intentionally opens
a fresh report/log, with a browser reload.

### State resets after restart

Confirm `storage.databasePath` resolves to the intended persistent file, the
process account can read/write it, and deployment did not remove it. Preserve the
same session secret and browser cookie. A new cookie creates a new workspace by
design.

### `ERR_MODULE_NOT_FOUND` for `tsx`

Run `npm ci` from the project root and start through `npm run serve`. Do not omit
`--import tsx` from a custom launcher.

### SQLite startup failure

If the error reports that the database is locked, verify whether the recorded Paris
ICC process is still running; never delete the lock while its owner is alive. The
server only reclaims a same-host lock after proving that owner is dead.

Check directory ownership and modes, available disk space, and the configured
path. Keep the original file for diagnosis; never work around corruption by
silently deleting it.

### Port 8787 is occupied

Identify the listener and stop the exact Paris ICC process gracefully. Do not use
a broad `pkill` expression.
