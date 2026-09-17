/**
 * A2A Hub — TỐI GIẢN + AN TOÀN TỐI THIỂU (public Internet).
 *
 * 1 file, duy nhất dependency `ws`. Registry = registry.json.
 *
 * An toàn tối thiểu (17/09):
 * - Rate limit 60 req/phút per caller (in-memory)
 * - Body limit 1MB (chặn OOM)
 * - SSRF guard: agent.url chỉ chấp nhận loopback/private (tunnel nội bộ)
 * - Admin key mạnh tự tạo (lưu registry.json), KHÔNG dùng key yếu
 * - /registry chỉ qua localhost — reverse proxy phải chặn từ ngoài
 *
 * Endpoint:
 *   GET  /health
 *   GET  /.well-known/agent-card.json
 *   POST /a2a       — JSON-RPC message/send → route (WS ưu tiên, HTTP fallback)
 *   POST /registry  — đăng ký agent (admin only, localhost)
 *   GET  /registry  — danh sách (admin only)
 *   WS   /agent-ws?token=<key> — kênh agent sau NAT
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 3200);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = path.join(HERE, 'registry.json');
const BODY_LIMIT = 1_000_000; // 1MB

// ---- registry (JSON file) ----
function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return { _admin_key: crypto.randomBytes(24).toString('hex') };
  }
}
let registry = loadRegistry();
if (!registry._admin_key || registry._admin_key.length < 32) {
  registry._admin_key = crypto.randomBytes(24).toString('hex');
}
function saveRegistry() {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}
if (!fs.existsSync(REGISTRY_FILE)) saveRegistry();

function hash(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}
function agentNameByKey(key) {
  if (key && key === registry._admin_key) return { admin: true };
  for (const [name, a] of Object.entries(registry)) {
    if (name !== '_admin_key' && a.key_hash === hash(key)) return { name };
  }
  return null;
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function isPrivateHost(host) {
  return (
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1|\[::1\])/.test(host) ||
    host.endsWith('.local')
  );
}

// ---- rate limit (in-memory, 60/phút per caller) ----
const rateLimit = new Map();
function rateLimited(caller) {
  const now = Date.now();
  const list = (rateLimit.get(caller) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 60) {
    rateLimit.set(caller, list);
    return true;
  }
  list.push(now);
  rateLimit.set(caller, list);
  return false;
}

// ---- WS kênh agent ----
const online = new Map(); // name → ws
const pending = new Map(); // `${agent}:${rpcId}` → {resolve, timer}

function routeViaWs(agentName, rpc, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const ws = online.get(agentName);
    if (!ws || ws.readyState !== 1) {
      resolve({ status: 502, body: JSON.stringify(rpcError(rpc.id, -32000, 'agent_offline')) });
      return;
    }
    const key = `${agentName}:${rpc.id}`;
    const timer = setTimeout(() => {
      pending.delete(key);
      resolve({ status: 504, body: JSON.stringify(rpcError(rpc.id, -32000, 'timeout')) });
    }, timeoutMs);
    pending.set(key, { resolve });
    ws.send(JSON.stringify({ type: 'task', rpc }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const who = agentNameByKey(key);
  const isAdmin = who?.admin === true;
  const caller = who?.admin ? 'admin' : who?.name;

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agents_online: [...online.keys()] }));
    return;
  }

  if (url.pathname === '/.well-known/agent-card.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'A2A Hub (minimal)',
      protocolVersion: '1.0',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    }));
    return;
  }

  if (url.pathname === '/registry' && req.method === 'POST') {
    if (!isAdmin) return res.writeHead(403).end();
    let body = '';
    for await (const c of req) body += c;
    if (body.length > BODY_LIMIT) return res.writeHead(413).end();
    const { name, url: agentUrl, skills } = JSON.parse(body);
    if (!name) return res.writeHead(400).end();
    const apiKey = crypto.randomBytes(24).toString('hex');
    registry[name] = {
      url: agentUrl ?? null,
      skills: skills ?? [],
      key_hash: hash(apiKey),
    };
    saveRegistry();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name, api_key: apiKey }));
    return;
  }

  if (url.pathname === '/registry' && req.method === 'GET') {
    if (!isAdmin) return res.writeHead(403).end();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(
      Object.fromEntries(Object.entries(registry).filter(([k]) => k !== '_admin_key')),
    ));
    return;
  }

  if (url.pathname === '/a2a' && req.method === 'POST') {
    if (!who) return res.writeHead(401).end();
    let body = '';
    for await (const c of req) {
      body += c;
      if (body.length > BODY_LIMIT) return res.writeHead(413).end();
    }
    let rpc;
    try {
      rpc = JSON.parse(body);
    } catch {
      return res.writeHead(400).end();
    }
    if (rateLimited(caller)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(rpcError(rpc.id ?? null, -32000, 'rate limited (60/phút)')));
    }
    const target = req.headers['x-a2a-target'] ?? rpc.params?.target;
    const agent = target ? registry[target] : null;
    if (!agent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcError(rpc.id, -32000, 'agent_not_found')));
      return;
    }

    // 1) WS agent online → đẩy qua WS, chờ result
    const ws = online.get(target);
    if (ws && ws.readyState === 1) {
      const out = await routeViaWs(target, rpc);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.body);
      return;
    }

    // 2) HTTP agent → fetch url — SSRF guard: chỉ loopback/private
    if (agent.url) {
      let host = null;
      try {
        host = new URL(agent.url).hostname;
      } catch {}
      if (!host || !isPrivateHost(host)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(rpcError(rpc.id, -32000, 'agent url phải là địa chỉ nội bộ')));
      }
      try {
        const fwd = await fetch(agent.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rpc),
        });
        res.writeHead(fwd.status, { 'Content-Type': 'application/json' });
        res.end(await fwd.text());
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcError(rpc.id, -32000, `unreachable: ${e.message}`)));
      }
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rpcError(rpc.id, -32000, 'agent_offline')));
    return;
  }

  res.writeHead(404).end();
});

// ---- WS server ----
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/agent-ws') return socket.destroy();
  const key = url.searchParams.get('token');
  const who = key ? agentNameByKey(key) : null;
  if (!who || who.admin) return socket.destroy();
  const name = who.name;
  wss.handleUpgrade(req, socket, head, (ws) => {
    // 1 agent = 1 connection — connection mới đá cũ (tranh chấp tên)
    const old = online.get(name);
    if (old && old !== ws) old.close();
    online.set(name, ws);
    ws.send(JSON.stringify({ type: 'welcome', name }));
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'result' && msg.rpc?.id != null) {
        const p = pending.get(`${name}:${msg.rpc.id}`);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(`${name}:${msg.rpc.id}`);
          p.resolve({ status: 200, body: JSON.stringify(msg.rpc) });
        }
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });
    ws.on('close', () => {
      if (online.get(name) === ws) online.delete(name);
    });
    ws.on('error', () => {});
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[a2a-hub-min] 127.0.0.1:${PORT} — admin key trong registry.json (_admin_key)`);
});