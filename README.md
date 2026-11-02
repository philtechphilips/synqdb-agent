# synqdb-agent

Local database relay agent for [SynqDB](https://synqdb.live) — connects your local databases to the SynqDB cloud dashboard without any firewall changes or port forwarding.

## How it works

The agent runs on your machine and opens an outbound WebSocket connection to the SynqDB API. When you query a local cluster from the dashboard, the API routes the query through this connection, the agent executes it against your local database, and returns the result.

```
SynqDB Dashboard → API → Agent (your machine) → Local Database
```

## Requirements

- Node.js 18 or higher
- A local MySQL, PostgreSQL, SQL Server, or SQLite database

## Installation

```bash
npm install -g synqdb-agent
```

Or run without installing:

```bash
npx synqdb-agent login
npx synqdb-agent
```

## Authentication

Authentication is browser-based — no keys to copy or paste.

```bash
synqdb-agent login
```

The terminal prints a confirmation code (for example `KX4P-9QTD`) and opens your browser to the SynqDB app. Log in (if you aren't already), check that the device name matches your machine, type the code from your terminal and click **Authorize**. The CLI detects approval automatically and saves the credential to `~/.synqdb-agent`.

The code is what stops someone else from sending you a link that approves *their* terminal: only codes shown in a terminal you started will work. Never enter a code someone sends you.

After that, just run:

```bash
synqdb-agent
```

## Usage

### Step 1 — Log in

```bash
synqdb-agent login
```

Opens your browser → enter the code shown in your terminal → **Authorize** → done. The credential is saved automatically.

### Step 2 — Save your database connections

```bash
synqdb-agent add local-postgres postgres://postgres@localhost:5432/mydb
```

You'll be asked for the password, so it never lands in your shell history. The connection is tested before it's saved. Then, in the dashboard, add a **Local database** cluster and pick `local-postgres`. The host, user and password stay in `~/.synqdb-agent` on your machine; SynqDB only ever sees the name.

```bash
synqdb-agent list            # names, hosts and databases (never passwords)
synqdb-agent test <name>     # check a connection
synqdb-agent remove <name>
```

URLs: `postgres://`, `mysql://`, `sqlserver://` (or `mssql://`), `sqlite:///absolute/path.db`. Add `?ssl=disable|prefer|require|verify` to choose TLS (default `prefer`). Connections added while the agent runs show up in the dashboard within a couple of seconds.

### Step 3 — Start the agent

```bash
synqdb-agent
```

The agent connects and stays running. Queries from your dashboard are routed through it in real time.

### Environment variable override

If you need to supply the key directly (e.g. in a CI/CD pipeline or Docker container), set:

```env
SYNQDB_AGENT_KEY=<your-agent-key>
```

The key resolution order is:
1. `SYNQDB_AGENT_KEY` environment variable
2. Saved credential at `~/.synqdb-agent` (written by `synqdb-agent login`)

### Custom server URL

```env
SYNQDB_SERVER_URL=https://api.synqdb.live
SYNQDB_FRONTEND_URL=https://synqdb.live
```

Or place them in a `.env` file in the directory where you run the agent.

## Running persistently

To keep the agent running across terminal sessions and machine restarts, use [PM2](https://pm2.keymetrics.io):

```bash
npm install -g pm2
pm2 start synqdb-agent --name synqdb-agent
pm2 save
pm2 startup
```

Useful PM2 commands:

```bash
pm2 logs synqdb-agent      # view live logs
pm2 status                 # check running status
pm2 restart synqdb-agent
pm2 stop synqdb-agent
```

## Revoking access

If you need to invalidate the current credential (e.g. the machine was compromised), go to **Dashboard → Project Settings → Local Agent → Rotate Key**. Any running agent will be disconnected. Run `synqdb-agent login` to re-authenticate.

## Supported databases

| Database | Driver |
|---|---|
| MySQL / MariaDB | `mysql2` |
| PostgreSQL | `pg` |
| SQL Server (MSSQL) | `mssql` |
| SQLite | `better-sqlite3` (optional dependency; the database "host" is the file path) |

Each connection uses the cluster's SSL setting. "Prefer" (the default) uses TLS when the database supports it and falls back to an unencrypted connection otherwise; "Require" and "Verify certificate" never fall back.

The agent needs version 1.2.0 or newer for saved connections, and 1.1.0 or newer for backups/restores, schema sync, paged queries and SQLite. Update with `npm install -g synqdb-agent@latest`.

## Security

- Authentication uses short-lived login requests (5-minute TTL) confirmed with a code shown only in your terminal — no long-lived secret is ever put in a URL
- The saved credential in `~/.synqdb-agent` is readable only by your user account (mode `0600`)
- The agent connects **outbound only** — no inbound ports are opened on your machine
- All queries are constructed server-side and use bound parameters; the agent never builds SQL from user input
- Connections saved with `synqdb-agent add` keep their host, user and password only in `~/.synqdb-agent`; the SynqDB API stores and sends nothing but the connection's name
- Local clusters created before saved connections existed still have their credentials stored encrypted (AES-256-GCM) by the API. Edit the cluster and pick a saved connection to move them to your machine — the API then deletes its copy

## License

MIT
