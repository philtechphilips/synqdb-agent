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

// ─── Resolve agentKey and serverUrl ──────────────────────────────────────────

const saved = loadConfig();

// --save flag: persist key (and optional server URL) then exit
if (process.argv.includes('--save')) {
  const keyArg = process.argv.find((a) => !a.startsWith('-') && process.argv.indexOf(a) > 1);
  const urlArg = process.argv[process.argv.indexOf('--save') + 1];
  const keyToSave = keyArg || process.env.SYNQDB_AGENT_KEY;
  const urlToSave = (!urlArg?.startsWith('-') ? urlArg : undefined) || process.env.SYNQDB_SERVER_URL;

  if (!keyToSave) {
    console.error('Usage: synqdb-agent --save <agentKey> [serverUrl]');
    process.exit(1);
  }

  saveConfig({
    agentKey: keyToSave,
    ...(urlToSave ? { serverUrl: urlToSave } : {}),
  });

  console.log(`Saved to ${CONFIG_PATH}`);
  console.log(`  agentKey: ${keyToSave}`);
  if (urlToSave) console.log(`  serverUrl: ${urlToSave}`);
  console.log('');
  console.log('Run `synqdb-agent` with no arguments to start.');
  process.exit(0);
}

const agentKey =
  process.argv[2] ||
  process.env.SYNQDB_AGENT_KEY ||
  saved.agentKey;

const serverUrl =
  process.argv[3] ||
  process.env.SYNQDB_SERVER_URL ||
  saved.serverUrl ||
  'https://api.synqdb.com';

if (!agentKey) {
  console.error('');
  console.error('  No agent key found. Options:');
  console.error('');
  console.error('  1. Save key once (recommended):');
  console.error('       synqdb-agent --save <agentKey>');
  console.error('       synqdb-agent');
  console.error('');
  console.error('  2. Pass key each time:');
  console.error('       synqdb-agent <agentKey>');
  console.error('');
  console.error('  3. Set environment variable:');
  console.error('       SYNQDB_AGENT_KEY=<agentKey> synqdb-agent');
  console.error('');
  process.exit(1);
}

// If key came from args (not saved), prompt user to save it
if (process.argv[2] && !saved.agentKey) {
  console.log(`Tip: run \`synqdb-agent --save ${process.argv[2]}\` to avoid typing the key next time.`);
}

console.log(`Connecting to SynqDB at ${serverUrl} ...`);

// Cache connections by a composite key so we don't open a new connection per query
const connectionCache = new Map();

function cacheKey(payload) {
  return `${payload.type}:${payload.host}:${payload.port}:${payload.database}:${payload.username}`;
}

// ─── MySQL ────────────────────────────────────────────────────────────────────

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

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

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

// ─── MSSQL ────────────────────────────────────────────────────────────────────

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

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function executeQuery(payload) {
  switch (payload.type) {
    case 'mysql':   return runMySQL(payload);
    case 'postgres': return runPostgres(payload);
    case 'mssql':   return runMSSQL(payload);
    default: throw new Error(`Unsupported database type: ${payload.type}`);
  }
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

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
  // If this was the first run with a key arg, auto-save it for next time
  if (process.argv[2] && !saved.agentKey) {
    saveConfig({ agentKey, serverUrl });
    console.log(`Key saved to ${CONFIG_PATH} — next time just run \`synqdb-agent\``);
  }
});

socket.on('auth_error', ({ message }) => {
  console.error(`Authentication failed: ${message}`);
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
