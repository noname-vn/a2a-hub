/**
 * DB pool A2A Hub — Postgres DB riêng `a2a_hub` (user `a2a_app`).
 * KHÔNG dùng chung DB với PHN/Akari — chỉ chung VPS.
 */
import pg from 'pg';

let pool = null;

export function getDbPool(url) {
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 5 });
  }
  return pool;
}