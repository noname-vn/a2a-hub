/**
 * A2A Hub — registry + router + **WS agent channel** (phương án 1).
 *
 * Mới (17/09): agents sau NAT (macOS/WSL cá nhân) KHÔNG cần SSH — kết nối
 * WebSocket ra hub với API key: wss://a2a.xkd.vn/agent-ws?token=<api-key>
 *
 * Giao thức WS (bọc JSON-RPC A2A):
 *   Agent → Hub : {type:'hello', name:'<tên-đã-đăng-ký>'}
 *   Hub  → Agent: {type:'task', rpc:{jsonrpc:'2.0', id, method, params}}
 *   Agent → Hub : {type:'result', rpc:{jsonrpc:'2.0', id, result|error}}
 *   Hub  → Agent: {type:'ping'}  / Agent → Hub: {type:'pong'}
 *
 * Route: message/send có X-A2A-Target (hoặc params.target) → agent WS online
 * → đẩy task qua WS, chờ result (timeout 300s) → trả client. Agent không
 * online → 502 agent_offline.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getDbPool } from './db.js';

const PORT = process.env.PORT || 3200;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const pool = getDbPool(process.env.DATABASE_URL);

// Kênh WS của các agent đang online: name → ws
const onlineAgents = new Map();
// hàng đợi chờ result: key `${agent}:${rpcId}` → {resolve, timer}
const pendingTasks = new Map();

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function bearer(req) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

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

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Gửi task tới agent online qua WS — chờ result (Promise) */
function routeViaWs(agentName, rpc, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const ws = onlineAgents.get(agentName);
    if (!ws || ws.readyState !== 1) {
      resolve({ status: 502, body: JSON.stringify(rpcError(rpc.id, -32000, 'agent_offline')) });
      return;
    }
    const key = `${agentName}:${rpc.id}`;
    const timer = setTimeout(() => {
      pendingTasks.delete(key);
      resolve({ status: 504, body: JSON.stringify(rpcError(rpc.id, -32000, 'agent timeout')) });
    }, timeoutMs);
    pendingTasks.set(key, { resolve, ws });
    ws.send(JSON.stringify({ type: 'task', rpc }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/.well-known/agent-card.json' && req.method === 'GET') {
    const card = {
      name: 'A2A Hub xkd.vn',
      description:
        'Hub registry + router — kết nối các Hermes agent qua A2A protocol v1.0',
      version: '1.1.0',
      protocolVersion: '1.0',
      url: 'https://a2a.xkd.vn/a2a',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [
        { id: 'registry.lookup', name: 'Agent registry lookup' },
        { id: 'route.task', name: 'Route task tới agent đã đăng ký' },
        { id: 'agent.ws', name: 'Agent WS channel — agent sau NAT không cần SSH' },
      ],
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      security: [{ bearer: [] }],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(card));
    return;
  }

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
      res.end(JSON.stringify({ name, api_key: apiKey }));
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
    const target = req.headers['x-a2a-target'] ?? rpc.params?.target ?? null;
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing target' }));
      return;
    }
    const { rows } = await pool.query(
      'SELECT * FROM agents WHERE name = $1 AND enabled = true',
      [target],
    );
    const agent = rows[0] ?? null;
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent_not_found' }));
      return;
    }

    // Ưu tiên WS channel nếu agent online — không thì fetch HTTP nội bộ
    if (onlineAgents.has(target)) {
      const out = await routeViaWs(target, rpc);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.body);
      void pool.query('UPDATE agents SET last_seen = now() WHERE name = $1', [target]);
      return;
    }

    const agentUrl = agent.agent_card?.url;
    if (!agentUrl) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent_not_found' }));
      return;
    }
    try {
      const fwd = await fetch(agentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Agent': agent.name },
        body: JSON.stringify(rpc),
      });
      const respBody = await fwd.text();
      res.writeHead(fwd.status, { 'Content-Type': 'application/json' });
      res.end(respBody);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc?.id ?? null,
        error: { code: -32000, message: `agent unreachable: ${e.message}` },
      }));
    }
    void pool.query('UPDATE agents SET last_seen = now() WHERE name = $1', [target]);
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'a2a-hub',
      agents_online: [...onlineAgents.keys()],
    }));
    return;
  }

  res.writeHead(404).end();
});

// ---- WebSocket kênh agent (auth bằng API key qua query) ----
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/agent-ws') {
    socket.destroy();
    return;
  }
  const key = url.searchParams.get('token');
  if (!key) {
    socket.destroy();
    return;
  }
  if (ADMIN_KEY && key === ADMIN_KEY) {
    socket.destroy(); // admin không dùng WS agent
    return;
  }
  const { rows } = await pool.query(
    'SELECT * FROM agents WHERE api_key_hash = $1 AND enabled = true',
    [hashKey(key)],
  );
  if (rows.length === 0) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.agentName = rows[0].name;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  // agent PHẢI gửi hello với name khớp agent đã đăng ký bằng key của nó
  ws.once('message', (data) => {
    let hello;
    try {
      hello = JSON.parse(data.toString());
    } catch {
      ws.close();
      return;
    }
    if (hello.type !== 'hello' || !hello.name) {
      ws.close();
      return;
    }
    // name phải khớp agent sở hữu key (tránh giả mạo tên agent khác)
    const url = new URL(req.url, 'http://localhost');
    const key = url.searchParams.get('token');
    void pool
      .query('SELECT name FROM agents WHERE api_key_hash = $1 AND enabled = true', [hashKey(key)])
      .then(({ rows }) => {
        if (rows.length === 0 || rows[0].name !== hello.name) {
          ws.close();
          return;
        }
        ws.agentName = hello.name;
        const old = onlineAgents.get(ws.agentName);
        if (old && old !== ws) old.close();
        onlineAgents.set(ws.agentName, ws);
        console.log(`[a2a-hub] agent online: ${ws.agentName}`);
        ws.send(JSON.stringify({ type: 'welcome', name: ws.agentName }));

        ws.on('message', (data) => {
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          if (msg.type === 'result' && msg.rpc?.id != null) {
            const key2 = `${ws.agentName}:${msg.rpc.id}`;
            const pending = pendingTasks.get(key2);
            if (pending) {
              clearTimeout(pending.timer);
              pendingTasks.delete(key2);
              pending.resolve({
                status: 200,
                body: JSON.stringify(msg.rpc),
              });
            }
          } else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        });

        ws.on('close', () => {
          if (onlineAgents.get(ws.agentName) === ws) {
            onlineAgents.delete(ws.agentName);
            console.log(`[a2a-hub] agent offline: ${ws.agentName}`);
          }
        });
        ws.on('error', () => {});
      });
  });
});

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