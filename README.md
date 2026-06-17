# synqdb-agent

Local database relay agent for [SynqDB](https://synqdb.live) — connects your local databases to the SynqDB cloud dashboard without any firewall changes or port forwarding.

## How it works

The agent runs on your machine and opens an outbound WebSocket connection to the SynqDB API. When you query a local cluster from the dashboard, the API routes the query through this connection, the agent executes it against your local database, and returns the result.

```
SynqDB Dashboard → API → Agent (your machine) → Local Database
```

## Requirements

- Node.js 18 or higher
- A local MySQL, PostgreSQL, or SQL Server database

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

This opens your browser to the SynqDB app. Log in (if you aren't already) and click **Authorize**. The CLI detects approval automatically and saves the credential to `~/.synqdb-agent`.

After that, just run:

```bash
synqdb-agent
```

## Usage

### Step 1 — Log in

```bash
synqdb-agent login
```

Opens your browser → click **Authorize** → done. Credential is saved automatically.

### Step 2 — Start the agent

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

## Security

- Authentication uses short-lived browser tokens (5-minute TTL) — no long-lived secrets are ever transmitted in a URL or terminal output
- The saved credential in `~/.synqdb-agent` is readable only by your user account (mode `0600`)
- The agent connects **outbound only** — no inbound ports are opened on your machine
- All queries are constructed server-side; the agent never builds SQL from user input
- Database credentials stay on your machine and are never sent to the SynqDB API

## License

MIT
