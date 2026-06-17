#!/usr/bin/env node
'use strict';

// Load .env from the directory where the command is run, if it exists
try { require('dotenv').config(); } catch {}

const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.synqdb-agent');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  const existing = loadConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...data }, null, 2), {
    mode: 0o600, // owner read/write only
  });
}

// ─── Resolve serverUrl ────────────────────────────────────────────────────────

const saved = loadConfig();

const serverUrl =
  process.env.SYNQDB_SERVER_URL ||
  (saved.serverUrl?.startsWith('http') ? saved.serverUrl : null) ||
  'https://api.synqdb.live';

const frontendUrl =
  process.env.SYNQDB_FRONTEND_URL ||
  (saved.frontendUrl?.startsWith('http') ? saved.frontendUrl : null) ||
  'https://synqdb.live';

// ─── login command ────────────────────────────────────────────────────────────

if (process.argv[2] === 'login') {
  runLogin().catch((err) => {
    console.error('Login failed:', err.message);
    process.exit(1);
  });
} else {
  runAgent();
}

async function runLogin() {
  // 1. Create a short-lived login token from the server
  const initRes = await fetch(`${serverUrl}/v1/auth/cli-login/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!initRes.ok) {
    throw new Error(`Server error: ${initRes.status}`);
  }
  const { loginToken } = await initRes.json();

  // 2. Open the authorize page in the user's browser
  const authorizeUrl = `${frontendUrl}/agent/authorize?token=${loginToken}`;
  console.log('');
  console.log('  Opening browser for authentication...');
  console.log(`  If the browser does not open, visit:\n  ${authorizeUrl}`);
  console.log('');

  try {
    const open = require('open');
    await open(authorizeUrl);
  } catch {
    // open might not be available in all environments — URL is printed above
  }

  // 3. Poll the server until the user approves (or token expires ~5 min)
  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  process.stdout.write('  Waiting for approval');

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    process.stdout.write('.');

    let pollRes;
    try {
      pollRes = await fetch(`${serverUrl}/v1/auth/cli-login/poll/${loginToken}`);
    } catch {
      // transient network error — keep retrying
      continue;
    }

    if (!pollRes.ok) {
      process.stdout.write('\n');
      throw new Error(`Token expired or invalid (server returned ${pollRes.status})`);
    }

    const body = await pollRes.json();

    if (body.status === 'authorized') {
      process.stdout.write('\n');
      saveConfig({ agentKey: body.agentKey, serverUrl });
      console.log('');
      console.log('  ✓ Authenticated! Agent key saved to', CONFIG_PATH);
      console.log('  Run `synqdb-agent` with no arguments to start the agent.');
      console.log('');
      return;
    }
  }

  process.stdout.write('\n');
  throw new Error('Login timed out. Please run `synqdb-agent login` again.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Agent runner ─────────────────────────────────────────────────────────────

function runAgent() {
  const agentKey = process.env.SYNQDB_AGENT_KEY || saved.agentKey;

  if (!agentKey) {
    console.error('');
    console.error('  No agent key found. Run:');
    console.error('');
    console.error('    synqdb-agent login');
    console.error('');
    console.error('  This opens your browser to authenticate — no key to copy.');
    console.error('');
    process.exit(1);
  }

  console.log(`Connecting to SynqDB at ${serverUrl} ...`);

  // Cache connections by a composite key so we don't open a new connection per query
  const connectionCache = new Map();

  function cacheKey(payload) {
    return `${payload.type}:${payload.host}:${payload.port}:${payload.database}:${payload.username}`;
  }

  // ─── MySQL ──────────────────────────────────────────────────────────────────

  async function runMySQL(payload) {
    const mysql = require('mysql2/promise');
    const key = cacheKey(payload);
    let pool = connectionCache.get(key);
    if (!pool) {
      pool = mysql.createPool({
        host: payload.host,
        port: payload.port,
        user: payload.username,
        password: payload.password || undefined,
        database: payload.database,
        waitForConnections: true,
        connectionLimit: 5,
        multipleStatements: true,
      });
      connectionCache.set(key, pool);
    }
    const [rows] = await pool.query(payload.sql, payload.params || []);
    const data = Array.isArray(rows) ? rows : [rows];
    return { rows: data, rowCount: data.length };
  }

  // ─── PostgreSQL ─────────────────────────────────────────────────────────────

  async function runPostgres(payload) {
    const { Pool } = require('pg');
    const key = cacheKey(payload);
    let pool = connectionCache.get(key);
    if (!pool) {
      pool = new Pool({
        host: payload.host,
        port: payload.port,
        user: payload.username,
        password: payload.password || undefined,
        database: payload.database,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });
      connectionCache.set(key, pool);
    }
    const res = await pool.query(payload.sql, payload.params || []);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }

  // ─── MSSQL ──────────────────────────────────────────────────────────────────

  async function runMSSQL(payload) {
    const mssql = require('mssql');
    const key = cacheKey(payload);
    let pool = connectionCache.get(key);
    if (!pool || !pool.connected) {
      pool = new mssql.ConnectionPool({
        server: payload.host,
        port: payload.port || 1433,
        user: payload.username,
        password: payload.password || undefined,
        database: payload.database,
        options: { encrypt: true, trustServerCertificate: true },
      });
      await pool.connect();
      connectionCache.set(key, pool);
    }
    const request = pool.request();
    if (payload.namedParams) {
      for (const [name, value] of Object.entries(payload.namedParams)) {
        request.input(name, value);
      }
    }
    const result = await request.query(payload.sql);
    const rows = result.recordset || [];
    return { rows, rowCount: result.rowsAffected?.[0] ?? rows.length };
  }

  // ─── Dispatch ────────────────────────────────────────────────────────────────

  async function executeQuery(payload) {
    switch (payload.type) {
      case 'mysql':    return runMySQL(payload);
      case 'postgres': return runPostgres(payload);
      case 'mssql':    return runMSSQL(payload);
      default: throw new Error(`Unsupported database type: ${payload.type}`);
    }
  }

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  const socket = io(`${serverUrl}/agent`, {
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    console.log('Connected. Authenticating ...');
    socket.emit('register', { agentKey });
  });

  socket.on('registered', ({ clusterId }) => {
    console.log(`Authenticated. Serving cluster: ${clusterId}`);
  });

  socket.on('auth_error', ({ message }) => {
    if (message && message.includes('rotated')) {
      console.error(`\n  ${message}`);
      console.error('  Run `synqdb-agent login` to re-authenticate.\n');
    } else {
      console.error(`Authentication failed: ${message}`);
      console.error('Run `synqdb-agent login` to re-authenticate.');
    }
    process.exit(1);
  });

  socket.on('query', async (payload) => {
    const { requestId } = payload;
    try {
      const { rows, rowCount } = await executeQuery(payload);
      socket.emit('result', { requestId, rows, rowCount });
    } catch (err) {
      console.error(`Query error [${requestId}]:`, err.message);
      socket.emit('error', { requestId, message: err.message });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${reason}. Reconnecting ...`);
  });

  socket.on('connect_error', (err) => {
    console.error('Connection error:', err.message);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down agent.');
    socket.disconnect();
    process.exit(0);
  });
}
