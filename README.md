# synqdb-agent

Local database relay agent for [SynqDB](https://synqdb.com) — connects your local databases to the SynqDB cloud dashboard without any firewall changes or port forwarding.

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
npx synqdb-agent <agentKey>
```

## Getting your agent key

1. Open the [SynqDB dashboard](https://synqdb.com)
2. Click **Add Connection**
3. Toggle **Local Database**
4. Fill in your local DB credentials and click **Generate Agent Key**
5. Copy the key — it is only shown once

## Usage

### Recommended — save once, run forever

On first use, save your key:

```bash
synqdb-agent --save <agentKey>
```

From then on, just run:

```bash
synqdb-agent
```

The key is stored in `~/.synqdb-agent` (readable only by your user account).

### Pass the key each time

```bash
synqdb-agent <agentKey>
```

The first successful connection will also auto-save the key so future runs need no arguments.

### Using environment variables

```bash
SYNQDB_AGENT_KEY=abc-123-def-456 synqdb-agent
```

Or place them in a `.env` file in the directory where you run the agent:

```env
SYNQDB_AGENT_KEY=abc-123-def-456
SYNQDB_SERVER_URL=https://api.synqdb.com
```

### Key resolution order

The agent looks for the key in this order:

1. CLI argument (`synqdb-agent <key>`)
2. `SYNQDB_AGENT_KEY` environment variable
3. Saved config at `~/.synqdb-agent`

### Environment variables

| Variable | Description | Default |
|---|---|---|
| `SYNQDB_AGENT_KEY` | Your agent key | — |
| `SYNQDB_SERVER_URL` | SynqDB API URL | `https://api.synqdb.com` |

## Running persistently

To keep the agent running in the background across terminal sessions and machine restarts, use [PM2](https://pm2.keymetrics.io):

```bash
npm install -g pm2
pm2 start synqdb-agent --name synqdb-agent -- <agentKey>
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

## Supported databases

| Database | Driver |
|---|---|
| MySQL / MariaDB | `mysql2` |
| PostgreSQL | `pg` |
| SQL Server (MSSQL) | `mssql` |

## Security

- Your agent key is a 128-bit random UUID — treat it like a password
- The agent connects **outbound only** — no inbound ports are opened on your machine
- All queries are constructed server-side; the agent never builds SQL from user input
- Credentials stay on your machine and are never sent to the SynqDB API

## License

MIT
