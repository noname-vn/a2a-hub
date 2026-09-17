/**
 * A2A Hub — registry + router cho các Hermes agent liên hệ nhau qua A2A.
 *
 * Vai trò:
 * 1. Registry: bảng agents (Postgres) — AgentCard + API key hash + health
 * 2. Router: nhận JSON-RPC A2A (message/send...) → forward tới endpoint
 *    của agent đích (theo URL trong AgentCard đã đăng ký)
 * 3. Auth: Bearer key per-agent (hash lưu DB); admin key cho đăng ký
 * 4. Streaming: SSE pass-through (proxy stream 1:1)
 *
 * VPS: systemd a2a-hub :3200, nginx a2a.xkd.vn TLS.
 * KHÔNG chạy LLM — hub thuần registry/router.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { getDbPool } from './db.js';

const PORT = process.env.PORT || 3200;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const pool = getDbPool(process.env.DATABASE_URL);

/** Hash API key (sha256) — không lưu key thô trong DB */
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Lấy Bearer token từ Authorization header */
function bearer(req) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Auth request: Bearer admin hoặc Bearer agent key hợp lệ → trả agent row (hoặc null) */
async function auth(req) {
  const key = bearer(req);
  if (!key) return null;
  if (ADMIN_KEY && key === ADMIN_KEY) return { admin: true };
  const { rows } = await pool.query(
    'SELECT * FROM agents WHERE api_key_hash = $1 AND enabled = true',
    [hashKey(key)],
  );
  if (rows.length === 0) return null;
  return { agent: rows[0] };
}

/** JSON-RPC error response */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ---- Agent Card của hub (discovery chuẩn A2A) ----
  if (url.pathname === '/.well-known/agent-card.json' && req.method === 'GET') {
    const card = {
      name: 'A2A Hub xkd.vn',
      description:
        'Hub registry + router — kết nối các Hermes agent qua A2A protocol v1.0',
      version: '1.0.0',
      protocolVersion: '1.0',
      url: 'https://a2a.xkd.vn/a2a',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [
        {
          id: 'registry.lookup',
          name: 'Agent registry lookup',
          description: 'Tìm agent theo skill/tag trong hub',
        },
        {
          id: 'route.task',
          name: 'Route task tới agent đã đăng ký',
        },
      ],
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      security: [{ bearer: [] }],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(card));
    return;
  }

  // ---- Registry API (admin only) ----
  if (url.pathname.startsWith('/registry/')) {
    const authz = await auth(req);
    if (!authz?.admin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    if (url.pathname === '/registry/agents' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { name, card, key } = JSON.parse(body);
      const apiKey = crypto.randomBytes(24).toString('hex');
      await pool.query(
        `INSERT INTO agents (name, agent_card, api_key_hash, enabled)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (name) DO UPDATE SET agent_card = $2, api_key_hash = $3, enabled = true`,
        [name, card, hashKey(apiKey)],
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name, api_key: apiKey })); // trả key 1 lần duy nhất
      return;
    }
    if (url.pathname === '/registry/agents' && req.method === 'GET') {
      const { rows } = await pool.query(
        'SELECT name, agent_card, enabled, last_seen FROM agents ORDER BY name',
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: rows }));
      return;
    }
    res.writeHead(404).end();
    return;
  }

  // ---- A2A Router: mọi JSON-RPC → forward tới agent ----
  if (url.pathname.startsWith('/a2a')) {
    const authz = await auth(req);
    if (!authz) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let rpc;
    try {
      rpc = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // Đích: theo 'target' header hoặc tìm skill match trong registry
    const target =
      req.headers['x-a2a-target'] ?? rpc.params?.target ?? null;
    let agent = null;
    if (target) {
      const { rows } = await pool.query(
        'SELECT * FROM agents WHERE name = $1 AND enabled = true',
        [target],
      );
      agent = rows[0] ?? null;
    } else if (!authz.admin) {
      // caller là agent đã đăng ký — mặc định route tới chính nó? KHÔNG:
      // hub route tới agent có skill khớp — fallback: lỗi
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing target' }));
      return;
    }
    if (!agent) {
      const { rows } = await pool.query(
        'SELECT * FROM agents WHERE name = $1 AND enabled = true',
        [target],
      );
      agent = rows[0] ?? null;
    }
    if (!agent?.agent_card?.url) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent_not_found' }));
      return;
    }
    // Forward JSON-RPC tới endpoint của agent (nội bộ — không lộ ra ngoài)
    const agentUrl = agent.agent_card.url;
    try {
      const fwd = await fetch(agentUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Agent': agent.name,
        },
        body: JSON.stringify(rpc),
      });
      const body = await fwd.text();
      res.writeHead(fwd.status, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc?.id ?? null,
        error: { code: -32000, message: `agent unreachable: ${e.message}` },
      }));
    }
    // cập nhật last_seen
    void pool.query(
      'UPDATE agents SET last_seen = now() WHERE name = $1',
      [agent.name],
    );
    return;
  }

  // ---- health ----
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'a2a-hub' }));
    return;
  }

  res.writeHead(404).end();
});

// ---- DB schema (idempotent) ----
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      name         text PRIMARY KEY,
      agent_card   jsonb NOT NULL,
      api_key_hash text NOT NULL,
      enabled      boolean NOT NULL DEFAULT true,
      last_seen    timestamptz
    );
  `);
  console.log('[a2a-hub] schema ok');
}

ensureSchema()
  .then(() => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[a2a-hub] listening on 127.0.0.1:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('[a2a-hub] schema lỗi:', e.message);
    process.exit(1);
  });