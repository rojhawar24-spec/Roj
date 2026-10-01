import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isVercel = process.env.VERCEL === '1';

if (isVercel && (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)) {
  throw new Error('Production database is not configured. Connect a Turso database to this Vercel project.');
}

let url;
let authToken;
if (isVercel) {
  url = process.env.TURSO_DATABASE_URL;
  authToken = process.env.TURSO_AUTH_TOKEN;
} else if (process.env.SHOP_DATABASE_URL) {
  url = process.env.SHOP_DATABASE_URL;
  authToken = process.env.TURSO_AUTH_TOKEN;
} else {
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  url = pathToFileURL(path.join(dataDir, 'shop.db')).href;
}

export const db = createClient({ url, authToken });

export async function execute(sql, connection = db) {
  return connection.execute(sql);
}

export async function executeMultiple(sql, connection = db) {
  return connection.executeMultiple(sql);
}

export async function getRow(sql, args = [], connection = db) {
  const result = await connection.execute({ sql, args });
  return result.rows[0] ? { ...result.rows[0] } : undefined;
}

export async function getRows(sql, args = [], connection = db) {
  const result = await connection.execute({ sql, args });
  return result.rows.map(row => ({ ...row }));
}

export async function run(sql, args = [], connection = db) {
  const result = await connection.execute({ sql, args });
  return { changes: Number(result.rowsAffected), lastInsertRowid: Number(result.lastInsertRowid || 0) };
}