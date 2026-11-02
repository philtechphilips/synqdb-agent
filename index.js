#!/usr/bin/env node
'use strict';

// Load .env from the directory where the command is run, if it exists
try { require('dotenv').config({ quiet: true }); } catch {}

const { io } = require('socket.io-client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');
const { version: AGENT_VERSION } = require('./package.json');

const CONFIG_PATH = path.join(os.homedir(), '.synqdb-agent');
const IDLE_POOL_MS = 10 * 60 * 1000;
const TX_IDLE_MS = 5 * 60 * 1000;
const MAX_RESULT_BYTES = 90 * 1024 * 1024; // server accepts up to 100 MB

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
  fs.chmodSync(CONFIG_PATH, 0o600); // also tighten files created by older versions
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

const HELP = `
  synqdb-agent ${AGENT_VERSION}

  Usage:
    synqdb-agent login                 Link this machine to your SynqDB account
    synqdb-agent add <name> [url]      Save a database connection on this machine
    synqdb-agent list                  Show saved connections (never the passwords)
    synqdb-agent test <name>           Check that a saved connection works
    synqdb-agent remove <name>         Delete a saved connection
    synqdb-agent                       Start the agent

  Connection URLs:
    postgres://user@localhost:5432/mydb?ssl=disable
    mysql://user@127.0.0.1:3306/mydb
    sqlserver://sa@localhost:1433/mydb
    sqlite:///absolute/path/to/file.db

  Leave the password out of the URL to be asked for it without it
  appearing in your shell history. Passwords stay in ~/.synqdb-agent on
  this machine; SynqDB only ever sees the connection's name.
`;

const fail = (label) => (err) => {
  console.error(`${label}: ${err.message}`);
  process.exit(1);
};


// ─── Saved connections ────────────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const PROTOCOLS = {
  'mysql:': 'mysql',
  'mariadb:': 'mysql',
  'postgres:': 'postgres',
  'postgresql:': 'postgres',
  'mssql:': 'mssql',
  'sqlserver:': 'mssql',
  'sqlite:': 'sqlite',
};
const DEFAULT_PORTS = { mysql: 3306, postgres: 5432, mssql: 1433 };
const SSL_ALIASES = {
  disable: 'disable',
  false: 'disable',
  prefer: 'prefer',
  require: 'require',
  true: 'require',
  verify: 'verify',
  'verify-ca': 'verify',
  'verify-full': 'verify',
};

function savedConnections() {
  return loadConfig().connections || {};
}

/** Name, engine and database of each saved connection — never secrets. */
function connectionList() {
  return Object.entries(savedConnections()).map(([name, c]) => ({
    name,
    type: c.type,
    database: c.database || null,
  }));
}

function parseConnectionUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`"${input}" is not a connection URL (e.g. postgres://user@localhost:5432/mydb)`);
  }
  const type = PROTOCOLS[url.protocol];
  if (!type) throw new Error(`Unsupported database "${url.protocol.replace(':', '')}".`);
  if (type === 'sqlite') {
    const file = decodeURIComponent(url.host ? `/${url.host}${url.pathname}` : url.pathname);
    const full = path.resolve(file);
    return { type, host: full, port: 0, username: '', password: null, database: path.basename(full), sslMode: 'disable' };
  }
  const ssl = (url.searchParams.get('ssl') || url.searchParams.get('sslmode') || 'prefer').toLowerCase();
  if (!SSL_ALIASES[ssl]) throw new Error(`Unknown ssl option "${ssl}" (use disable, prefer, require or verify).`);
  return {
    type,
    host: decodeURIComponent(url.hostname).replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : DEFAULT_PORTS[type],
    username: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : null,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    sslMode: SSL_ALIASES[ssl],
  };
}

/** Asks a question on the terminal; `hidden` echoes nothing (for passwords). */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden && process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function promptConnection() {
  const typeAnswer = (await ask('  Database type (postgres, mysql, mssql, sqlite): ')).trim().toLowerCase();
  const type = PROTOCOLS[`${typeAnswer}:`];
  if (!type) throw new Error(`Unsupported database "${typeAnswer}".`);
  if (type === 'sqlite') {
    const file = path.resolve((await ask('  Path to the .db file: ')).trim());
    return { type, host: file, port: 0, username: '', password: null, database: path.basename(file), sslMode: 'disable' };
  }
  const host = (await ask('  Host [localhost]: ')).trim() || 'localhost';
  const port = Number((await ask(`  Port [${DEFAULT_PORTS[type]}]: `)).trim() || DEFAULT_PORTS[type]);
  const database = (await ask('  Database name: ')).trim();
  const username = (await ask('  Username: ')).trim();
  const ssl = (await ask('  SSL (disable, prefer, require, verify) [prefer]: ')).trim().toLowerCase() || 'prefer';
  if (!SSL_ALIASES[ssl]) throw new Error(`Unknown ssl option "${ssl}".`);
  return { type, host, port, username, password: null, database, sslMode: SSL_ALIASES[ssl] };
}

async function closeAllPools() {
  for (const entry of pools.values()) await entry.promise.then(closePool, () => {});
  pools.clear();
}

async function checkConnection(conn) {
  await runQuery({ ...conn, sql: 'SELECT 1', params: [] });
}

async function runAdd(args) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const [nameArg, url] = args.filter((a) => !a.startsWith('--'));
  const name = nameArg || (await ask('  Connection name (e.g. local-postgres): ')).trim();
  if (!NAME_RE.test(name)) {
    throw new Error('Names may use letters, numbers, ".", "_" and "-" (up to 64 characters).');
  }
  const conn = url ? parseConnectionUrl(url) : await promptConnection();
  if (conn.type !== 'sqlite' && conn.password === null) {
    const password = await ask(`  Password for ${conn.username || 'the user'}@${conn.host} (leave empty for none): `, { hidden: true });
    conn.password = password || null;
  }

  if (!flags.has('--no-test')) {
    process.stdout.write('  Testing the connection... ');
    try {
      await checkConnection(conn);
      console.log('ok');
    } catch (err) {
      console.log('failed');
      await closeAllPools();
      if (!flags.has('--force')) {
        throw new Error(`${err.message}\n  Fix the details, or add --force to save it anyway.`);
      }
    }
    await closeAllPools();
  }

  saveConfig({ connections: { ...savedConnections(), [name]: conn } });
  console.log('');
  console.log(`  ✓ Saved "${name}" (${conn.type}). The password stays on this machine.`);
  console.log(`  In the dashboard, add a Local cluster and choose "${name}".`);
  console.log('');
}

function runList() {
  const entries = Object.entries(savedConnections());
  if (entries.length === 0) {
    console.log('  No saved connections. Add one with: synqdb-agent add <name> <url>');
    return;
  }
  for (const [name, c] of entries) {
    const where = c.type === 'sqlite' ? c.host : `${c.username ? `${c.username}@` : ''}${c.host}:${c.port}/${c.database}`;
    console.log(`  ${name.padEnd(24)} ${c.type.padEnd(9)} ${where}  ssl=${c.sslMode}`);
  }
}

function runRemove(name) {
  const connections = savedConnections();
  if (!name || !connections[name]) {
    console.error(`  No saved connection named "${name ?? ''}".`);
    process.exit(1);
  }
  delete connections[name];
  saveConfig({ connections });
  console.log(`  Removed "${name}".`);
}

async function runTest(name) {
  const conn = savedConnections()[name];
  if (!conn) throw new Error(`No saved connection named "${name ?? ''}".`);
  await checkConnection(conn);
  await closeAllPools();
  console.log(`  ✓ "${name}" works.`);
}

/** Replaces a connection name in a request with the details saved here. */
function resolveTarget(payload) {
  if (!payload.connection) return payload;
  const conn = savedConnections()[payload.connection];
  if (!conn) {
    throw new Error(
      `Connection "${payload.connection}" isn't saved on this agent. Run: synqdb-agent add ${payload.connection} <connection-url>`,
    );
  }
  if (payload.type && conn.type !== payload.type) {
    throw new Error(`Connection "${payload.connection}" is ${conn.type}, but the cluster expects ${payload.type}.`);
  }
  return { ...payload, ...conn };
}

// ─── login command ────────────────────────────────────────────────────────────

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser available — the URL is printed instead.
  }
}

async function runLogin() {
  // 1. Create a short-lived login request on the server
  const initRes = await fetch(`${serverUrl}/v1/auth/cli-login/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostname: os.hostname() }),
  });
  if (!initRes.ok) throw new Error(`Server error: ${initRes.status}`);
  const { loginToken, userCode } = await initRes.json();

  // 2. Show the code and open the authorize page. The page asks for this
  //    code, so a link sent by someone else can't approve their terminal.
  const authorizeUrl = `${frontendUrl}/agent/authorize?token=${encodeURIComponent(loginToken)}`;
  console.log('');
  console.log('  Your confirmation code:');
  console.log('');
  console.log(`      ${userCode}`);
  console.log('');
  console.log('  Opening your browser. Enter the code above to approve this terminal.');
  console.log(`  If the browser does not open, visit:\n  ${authorizeUrl}`);
  console.log('');
  openBrowser(authorizeUrl);

  // 3. Poll until the user approves or denies (the request expires after ~5 min)
  const deadline = Date.now() + 5 * 60 * 1000;
  process.stdout.write('  Waiting for approval');
  while (Date.now() < deadline) {
    await sleep(2000);
    process.stdout.write('.');
    let pollRes;
    try {
      pollRes = await fetch(`${serverUrl}/v1/auth/cli-login/poll/${encodeURIComponent(loginToken)}`);
    } catch {
      continue; // transient network error — keep retrying
    }
    if (!pollRes.ok) {
      process.stdout.write('\n');
      throw new Error(`Login request expired or invalid (server returned ${pollRes.status})`);
    }
    const body = await pollRes.json();
    if (body.status === 'denied') {
      process.stdout.write('\n');
      throw new Error('The request was denied in the browser.');
    }
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

// ─── Value normalization (must match the server's) ───────────────────────────

const pad = (n, w = 2) => String(n).padStart(w, '0');
const utcDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcTime = (d) => {
  const ms = d.getUTCMilliseconds();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms ? `.${pad(ms, 3)}` : ''}`;
};

function normalizeValue(value, sqlType) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '0x' + Buffer.from(value).toString('hex');
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const t = String(sqlType || '').toLowerCase();
    if (t === 'date') return utcDate(value);
    if (t === 'time') return utcTime(value);
    if (t === 'datetimeoffset') return value.toISOString();
    return `${utcDate(value)} ${utcTime(value)}`;
  }
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v));
  return value;
}

function normalizeRows(rows, types) {
  return rows.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) out[key] = normalizeValue(row[key], types && types[key]);
    return out;
  });
}

function isHeader(r) {
  return r && typeof r === 'object' && !Array.isArray(r) && 'affectedRows' in r;
}

// ─── Drivers ──────────────────────────────────────────────────────────────────

const NO_TLS = /does not support SSL|does not support secure connection|HANDSHAKE_NO_SSL_SUPPORT/i;

let pgTypes = null;
function getPgTypes() {
  if (pgTypes) return pgTypes;
  const pg = require('pg');
  const raw = new Set([1082, 1083, 1114, 1184, 1186, 1266, 600, 718]);
  const textArrays = new Set([1182, 1183, 1115, 1185, 1187, 1270]);
  const textArray = pg.types.getTypeParser(1009);
  pgTypes = {
    getTypeParser(oid, format) {
      if (raw.has(oid)) return (v) => v;
      if (textArrays.has(oid)) return textArray;
      return pg.types.getTypeParser(oid, format);
    },
  };
  return pgTypes;
}

/**
 * tedious returns DECIMAL/NUMERIC/MONEY as JS doubles and drops digits;
 * read their bytes as exact decimal strings instead (same as the server).
 */
let decimalsPatched = false;
function patchTediousDecimals() {
  if (decimalsPatched) return;
  decimalsPatched = true;
  const roots = new Set();
  for (const from of [() => path.dirname(require.resolve('mssql')), () => __dirname]) {
    try {
      roots.add(path.dirname(require.resolve('tedious/package.json', { paths: [from()] })));
    } catch {}
  }
  const scaled = (negative, magnitude, scale) => {
    let digits = magnitude.toString();
    if (scale > 0) {
      digits = digits.padStart(scale + 1, '0');
      digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    }
    return negative && magnitude !== 0n ? `-${digits}` : digits;
  };
  for (const root of roots) {
    const parser = require(`${root}/lib/value-parser`);
    const helpers = require(`${root}/lib/token/helpers`);
    if (parser.__synqExactDecimals) continue;
    const need = (buf, end) => {
      if (buf.length < end) throw new helpers.NotEnoughDataError(end);
    };
    const readMoney = (buf, offset, bytes) => {
      need(buf, offset + bytes);
      const value =
        bytes === 4
          ? BigInt(buf.readInt32LE(offset))
          : (BigInt(buf.readInt32LE(offset)) << 32n) | BigInt(buf.readUInt32LE(offset + 4));
      return new helpers.Result(scaled(value < 0n, value < 0n ? -value : value, 4), offset + bytes);
    };
    const original = parser.readValue;
    parser.readValue = function readValue(buf, offset, metadata, ...rest) {
      const name = metadata && metadata.type && metadata.type.name;
      if (name === 'NumericN' || name === 'DecimalN') {
        need(buf, offset + 1);
        const length = buf.readUInt8(offset);
        if (length === 0) return new helpers.Result(null, offset + 1);
        need(buf, offset + 1 + length);
        let magnitude = 0n;
        for (let i = length - 1; i >= 1; i--) magnitude = (magnitude << 8n) | BigInt(buf[offset + 1 + i]);
        return new helpers.Result(scaled(buf.readUInt8(offset + 1) !== 1, magnitude, metadata.scale || 0), offset + 1 + length);
      }
      if (name === 'Money') return readMoney(buf, offset, 8);
      if (name === 'SmallMoney') return readMoney(buf, offset, 4);
      if (name === 'MoneyN') {
        need(buf, offset + 1);
        const length = buf.readUInt8(offset);
        if (length === 0) return new helpers.Result(null, offset + 1);
        return readMoney(buf, offset + 1, length === 4 ? 4 : 8);
      }
      return original.call(this, buf, offset, metadata, ...rest);
    };
    parser.__synqExactDecimals = true;
  }
}

function mssqlTypes(recordset) {
  const out = {};
  const columns = (recordset && recordset.columns) || {};
  for (const key of Object.keys(columns)) {
    const decl = columns[key] && columns[key].type && columns[key].type.declaration;
    if (decl) out[key] = String(decl);
  }
  return out;
}

function bindMssql(mssql, request, payload) {
  const params = payload.params || [];
  const kinds = payload.paramKinds || [];
  if (params.length === 0 && payload.namedParams) {
    for (const [name, value] of Object.entries(payload.namedParams)) request.input(name, value);
    return;
  }
  params.forEach((value, i) => {
    const name = `p${i + 1}`;
    if (kinds[i] === 'binary') request.input(name, mssql.VarBinary(mssql.MAX), value ?? null);
    else if (value === null || value === undefined) request.input(name, mssql.NVarChar(mssql.MAX), null);
    else if (typeof value === 'number') {
      if (!Number.isInteger(value)) request.input(name, mssql.Float, value);
      else if (Math.abs(value) > 2147483647) request.input(name, mssql.BigInt, value);
      else request.input(name, mssql.Int, value);
    } else if (typeof value === 'string') request.input(name, mssql.NVarChar(mssql.MAX), value);
    else request.input(name, value);
  });
}

/**
 * Pools keyed by a fingerprint of every connection setting (including the
 * password), so fixing credentials in the dashboard takes effect at once.
 */
const pools = new Map();

function fingerprint(p) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([p.type, p.host, p.port, p.username, p.password, p.database, p.sslMode || 'disable']))
    .digest('hex');
}

async function createPool(p, forcePlain = false) {
  const requested = p.sslMode || 'disable';
  const mode = forcePlain ? 'disable' : requested === 'prefer' ? 'require' : requested;
  try {
    if (p.type === 'mysql') {
      const mysql = require('mysql2/promise');
      const pool = mysql.createPool({
        host: p.host,
        port: p.port,
        user: p.username,
        password: p.password || undefined,
        database: p.database,
        ssl: mode === 'disable' ? undefined : { rejectUnauthorized: mode === 'verify' },
        connectionLimit: 5,
        maxIdle: 2,
        idleTimeout: 60000,
        connectTimeout: 10000,
        multipleStatements: true,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      try {
        (await pool.getConnection()).release();
      } catch (e) {
        await pool.end().catch(() => {});
        throw e;
      }
      return { type: 'mysql', pool };
    }
    if (p.type === 'postgres') {
      const { Pool } = require('pg');
      const pool = new Pool({
        host: p.host,
        port: p.port,
        user: p.username,
        password: p.password || undefined,
        database: p.database,
        ssl: mode === 'disable' ? false : { rejectUnauthorized: mode === 'verify' },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        types: getPgTypes(),
      });
      pool.on('error', () => {});
      try {
        (await pool.connect()).release();
      } catch (e) {
        await pool.end().catch(() => {});
        throw e;
      }
      return { type: 'postgres', pool };
    }
    if (p.type === 'mssql') {
      patchTediousDecimals();
      const mssql = require('mssql');
      const pool = new mssql.ConnectionPool({
        server: p.host,
        port: p.port || 1433,
        user: p.username,
        password: p.password || undefined,
        database: p.database,
        connectionTimeout: 10000,
        requestTimeout: 5 * 60 * 1000,
        pool: { max: 5, idleTimeoutMillis: 30000 },
        options: { encrypt: mode !== 'disable', trustServerCertificate: mode !== 'verify', useUTC: true },
      });
      await pool.connect();
      return { type: 'mssql', pool };
    }
    if (p.type === 'sqlite') {
      return { type: 'sqlite', db: openSqlite(p.host) };
    }
    throw new Error(`Unsupported database type: ${p.type}`);
  } catch (e) {
    if (requested === 'prefer' && !forcePlain && NO_TLS.test(String(e.message))) return createPool(p, true);
    throw e;
  }
}

function openSqlite(file) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    throw new Error('SQLite support needs better-sqlite3. Reinstall with: npm install -g synqdb-agent@latest');
  }
  const db = new Database(path.resolve(file), { fileMustExist: true });
  db.defaultSafeIntegers(true); // INTEGERs beyond 2^53 stay exact
  return db;
}

async function closePool(entry) {
  try {
    if (entry.type === 'sqlite') entry.db.close();
    else if (entry.type === 'mssql') await entry.pool.close();
    else await entry.pool.end();
  } catch {}
}

async function getPool(p) {
  const key = fingerprint(p);
  let entry = pools.get(key);
  if (!entry) {
    entry = { promise: createPool(p), lastUsed: Date.now() };
    pools.set(key, entry);
    entry.promise.catch(() => pools.delete(key));
  }
  entry.lastUsed = Date.now();
  return entry.promise;
}

setInterval(async () => {
  for (const [key, entry] of pools) {
    if (Date.now() - entry.lastUsed > IDLE_POOL_MS) {
      pools.delete(key);
      entry.promise.then(closePool, () => {});
    }
  }
}, 60000).unref();

// ─── Query modes ──────────────────────────────────────────────────────────────

/** Runs one statement on a pool, client, transaction or SQLite db. */
async function runOn(target, payload) {
  const params = payload.params || [];
  if (target.type === 'mysql') {
    const [res] = await target.runner.query({ sql: payload.sql, values: params });
    if (isHeader(res)) return { rows: [], rowCount: res.affectedRows, insertId: res.insertId || null };
    const rows = Array.isArray(res) ? res : [];
    return { rows: normalizeRows(rows), rowCount: rows.length };
  }
  if (target.type === 'postgres') {
    const res = await target.runner.query({ text: payload.sql, values: params });
    return { rows: normalizeRows(res.rows), rowCount: res.rowCount ?? res.rows.length };
  }
  if (target.type === 'mssql') {
    const mssql = require('mssql');
    const request = target.tx ? new mssql.Request(target.tx) : target.runner.request();
    bindMssql(mssql, request, payload);
    const res = await request.query(payload.sql);
    const rs = res.recordset;
    const rows = rs ? normalizeRows(rs, mssqlTypes(rs)) : [];
    const affected = (res.rowsAffected || []).reduce((a, b) => a + b, 0);
    return { rows, rowCount: rs ? rows.length : affected };
  }
  // sqlite
  const stmt = target.db.prepare(payload.sql);
  if (stmt.reader) {
    const rows = normalizeRows(stmt.all(params));
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(params);
  return { rows: [], rowCount: info.changes, insertId: normalizeValue(info.lastInsertRowid) };
}

async function runQuery(payload) {
  payload = resolveTarget(payload);
  const entry = await getPool(payload);
  const target =
    entry.type === 'sqlite' ? { type: 'sqlite', db: entry.db } : { type: entry.type, runner: entry.pool };
  return runOn(target, payload);
}

async function runScript(payload) {
  payload = resolveTarget(payload);
  const entry = await getPool(payload);
  const toResult = (parts) => ({
    results: parts,
    rowCounts: parts.map((r) => (Array.isArray(r) ? r.length : r.affectedRows)),
  });
  if (entry.type === 'mysql') {
    const [res, fields] = await entry.pool.query({ sql: payload.sql });
    const multi = Array.isArray(res) && Array.isArray(fields) && fields.some((f) => f == null || Array.isArray(f));
    const parts = multi ? res : [res];
    return toResult(parts.map((r) => (isHeader(r) ? { affectedRows: r.affectedRows } : normalizeRows(r || []))));
  }
  if (entry.type === 'postgres') {
    const res = await entry.pool.query(payload.sql);
    const parts = Array.isArray(res) ? res : [res];
    return toResult(
      parts.map((r) => (r.fields && r.fields.length > 0 ? normalizeRows(r.rows) : { affectedRows: r.rowCount ?? 0 })),
    );
  }
  if (entry.type === 'mssql') {
    const res = await entry.pool.request().query(payload.sql);
    const sets = res.recordsets || [];
    if (sets.length > 0) return toResult(sets.map((rs) => normalizeRows(rs, mssqlTypes(rs))));
    return toResult([{ affectedRows: (res.rowsAffected || []).reduce((a, b) => a + b, 0) }]);
  }
  // SQLite: the server sends one statement at a time.
  const stmt = entry.db.prepare(payload.sql);
  if (stmt.reader) return toResult([normalizeRows(stmt.all())]);
  return toResult([{ affectedRows: stmt.run().changes }]);
}

/** Streams a single row-returning query, keeping only one page of rows. */
async function runPage(payload) {
  payload = resolveTarget(payload);
  const entry = await getPool(payload);
  const { offset = 0, limit = 100 } = payload;
  const rows = [];
  let total = 0;
  const take = (row) => {
    if (total >= offset && rows.length < limit) rows.push(row);
    total++;
  };

  if (entry.type === 'mysql') {
    const conn = await entry.pool.getConnection();
    try {
      await new Promise((resolve, reject) => {
        const q = conn.connection.query({ sql: payload.sql });
        q.on('result', (row) => {
          if (!isHeader(row)) take(row);
        });
        q.on('error', reject);
        q.on('end', resolve);
      });
    } finally {
      conn.release();
    }
    return { rows: normalizeRows(rows), total };
  }
  if (entry.type === 'postgres') {
    const { Query } = require('pg');
    const client = await entry.pool.connect();
    try {
      await new Promise((resolve, reject) => {
        const q = new Query(payload.sql);
        q.on('row', take);
        q.on('error', reject);
        q.on('end', resolve);
        client.query(q);
      });
    } finally {
      client.release();
    }
    return { rows: normalizeRows(rows), total };
  }
  if (entry.type === 'mssql') {
    let types = {};
    await new Promise((resolve, reject) => {
      const request = entry.pool.request();
      request.stream = true;
      request.on('recordset', (columns) => {
        types = mssqlTypes({ columns });
      });
      request.on('row', take);
      request.on('error', reject);
      request.on('done', resolve);
      const pending = request.query(payload.sql);
      if (pending && pending.catch) pending.catch(reject);
    });
    return { rows: normalizeRows(rows, types), total };
  }
  for (const row of entry.db.prepare(payload.sql).iterate()) take(row);
  return { rows: normalizeRows(rows), total };
}

// ─── Transactions ─────────────────────────────────────────────────────────────

const transactions = new Map();

async function beginTx(payload) {
  payload = resolveTarget(payload);
  const txId = crypto.randomUUID();
  let tx;
  if (payload.type === 'sqlite') {
    const db = openSqlite(payload.host); // dedicated connection for isolation
    db.exec('BEGIN IMMEDIATE');
    tx = { type: 'sqlite', db, end: (commit) => { db.exec(commit ? 'COMMIT' : 'ROLLBACK'); db.close(); } };
  } else {
    const entry = await getPool(payload);
    if (entry.type === 'mysql') {
      const conn = await entry.pool.getConnection();
      await conn.beginTransaction();
      tx = {
        type: 'mysql',
        runner: conn,
        end: async (commit) => {
          try {
            if (commit) await conn.commit();
            else await conn.rollback();
          } finally {
            conn.release();
          }
        },
      };
    } else if (entry.type === 'postgres') {
      const client = await entry.pool.connect();
      await client.query('BEGIN');
      tx = {
        type: 'postgres',
        runner: client,
        end: async (commit) => {
          try {
            await client.query(commit ? 'COMMIT' : 'ROLLBACK');
          } finally {
            client.release();
          }
        },
      };
    } else {
      const mssql = require('mssql');
      const t = new mssql.Transaction(entry.pool);
      await t.begin();
      tx = { type: 'mssql', tx: t, end: (commit) => (commit ? t.commit() : t.rollback()) };
    }
  }
  tx.timer = setTimeout(() => endTx(txId, false).catch(() => {}), TX_IDLE_MS);
  transactions.set(txId, tx);
  return { txId };
}

async function queryTx(payload) {
  const tx = transactions.get(payload.txId);
  if (!tx) throw new Error('Transaction not found (it may have timed out).');
  clearTimeout(tx.timer);
  tx.timer = setTimeout(() => endTx(payload.txId, false).catch(() => {}), TX_IDLE_MS);
  const results = [];
  for (const statement of payload.statements || []) results.push(await runOn(tx, statement));
  return { results };
}

async function endTx(txId, commit) {
  const tx = transactions.get(txId);
  if (!tx) return { success: !commit };
  transactions.delete(txId);
  clearTimeout(tx.timer);
  await tx.end(commit);
  return { success: true };
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

  console.log(`synqdb-agent ${AGENT_VERSION} connecting to ${serverUrl} ...`);

  const socket = io(`${serverUrl}/agent`, {
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    transports: ['websocket'],
  });

  const reply = (requestId, work) => {
    work
      .then((result) => {
        const size = Buffer.byteLength(JSON.stringify(result));
        if (size > MAX_RESULT_BYTES) {
          throw new Error(
            `Result is too large to send (${Math.round(size / 1048576)} MB). Add a LIMIT or enable paging.`,
          );
        }
        socket.emit('result', { requestId, ...result });
      })
      .catch((err) => {
        console.error(`Query error [${requestId}]:`, err.message);
        socket.emit('error', { requestId, message: err.message });
      });
  };

  socket.on('connect', () => {
    console.log('Connected. Authenticating ...');
    socket.emit('register', { agentKey, version: AGENT_VERSION, connections: connectionList() });
  });

  // Let the dashboard see connections added or removed while running.
  fs.watchFile(CONFIG_PATH, { interval: 1500 }, () => {
    if (socket.connected) socket.emit('connections', { connections: connectionList() });
  });

  socket.on('registered', () => {
    console.log('Authenticated. Waiting for queries from your dashboard.');
  });

  socket.on('auth_error', ({ message }) => {
    console.error(`\n  ${message}`);
    console.error('  Run `synqdb-agent login` to re-authenticate.\n');
    process.exit(1);
  });

  socket.on('query', (payload) => {
    const mode = payload.mode || 'run';
    reply(
      payload.requestId,
      mode === 'page' ? runPage(payload) : mode === 'script' ? runScript(payload) : runQuery(payload),
    );
  });
  socket.on('tx_begin', (payload) => reply(payload.requestId, beginTx(payload)));
  socket.on('tx_query', (payload) => reply(payload.requestId, queryTx(payload)));
  socket.on('tx_end', (payload) => reply(payload.requestId, endTx(payload.txId, !!payload.commit)));

  socket.on('disconnect', (reason) => {
    console.log(`Disconnected: ${reason}. Reconnecting ...`);
    // The server can't finish these any more; roll them back.
    for (const txId of [...transactions.keys()]) endTx(txId, false).catch(() => {});
  });

  socket.on('connect_error', (err) => {
    console.error('Connection error:', err.message);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down agent.');
    socket.disconnect();
    for (const txId of [...transactions.keys()]) await endTx(txId, false).catch(() => {});
    for (const entry of pools.values()) await entry.promise.then(closePool, () => {});
    process.exit(0);
  });
}

// Dispatch last, so every module-level value above is initialised.
function main() {
  switch (process.argv[2]) {
    case 'login':
      runLogin().catch(fail('Login failed'));
      break;
    case 'add':
      runAdd(process.argv.slice(3)).catch(fail('Could not add the connection'));
      break;
    case 'list':
    case 'ls':
      runList();
      break;
    case 'remove':
    case 'rm':
      runRemove(process.argv[3]);
      break;
    case 'test':
      runTest(process.argv[3]).catch(fail('Connection failed'));
      break;
    case '--version':
    case '-v':
      console.log(AGENT_VERSION);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    case undefined:
      runAgent();
      break;
    default:
      console.error(`Unknown command "${process.argv[2]}".`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
