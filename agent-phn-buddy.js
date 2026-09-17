/**
 * Agent demo #1: "phn-buddy" — trả lời câu hỏi về Phòng Hai Người
 * (query DB PHN trực tiếp — read-only).
 *
 * Chạy trên VPS :3210, đăng ký vào hub với skill "phn.room.status".
 * Endpoint A2A: POST /a2a (JSON-RPC message/send đơn giản — echo skill).
 */
import http from 'node:http';
import { execSync } from 'node:child_process';

const PORT = process.env.PORT || 3210;

const AGENT_CARD = {
  name: 'phn-buddy',
  description:
    'Agent trả lời câu hỏi về Phòng Hai Người: phiên đang mở, số cặp, trạng thái kết nối',
  version: '1.0.0',
  protocolVersion: '1.0',
  url: 'http://127.0.0.1:3210/a2a',
  capabilities: { streaming: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    {
      id: 'phn.room.status',
      name: 'Trạng thái phòng PHN',
      description: 'Báo số phiên đang mở, cặp đôi, kết nối 24h qua',
    },
  ],
};

/** Query DB PHN qua psql (sudo -u postgres) */
function queryPhn(sql) {
  try {
    const out = execSync(
      `sudo -u postgres psql phong_hai_nguoi -t -A -c "${sql.replaceAll('"', '\\"')}"`,
      { encoding: 'utf8', timeout: 5000 },
    );
    return out.trim();
  } catch (e) {
    return `Lỗi query: ${e.message.split('\n')[0]}`;
  }
}

/** Trả lời câu hỏi về PHN — rule-based (KHÔNG LLM) */
function answer(text) {
  const t = text.toLowerCase();
  if (t.includes('phiên') || t.includes('session') || t.includes('đang mở')) {
    const open = queryPhn(
      "SELECT count(*) FROM sessions WHERE ended_at IS NULL AND started_at > now() - interval '24 hours'",
    );
    const dur = queryPhn(
      "SELECT coalesce(round(avg(extract(epoch from (ended_at - started_at)))/60), 0)::int FROM sessions WHERE ended_at IS NOT NULL AND started_at > now() - interval '24 hours'",
    );
    return `Phiên đang mở: ${open || 0}. Thời lượng trung bình 24h qua: ${dur} phút.`;
  }
  if (t.includes('cặp') || t.includes('pair')) {
    const pairs = queryPhn('SELECT count(*) FROM pairs');
    return `Tổng số cặp đôi đã tạo: ${pairs || 0}.`;
  }
  if (t.includes('metric') || t.includes('sự kiện') || t.includes('events')) {
    const ev = queryPhn(
      "SELECT name || ': ' || count(*) FROM events WHERE at > now() - interval '24 hours' GROUP BY name ORDER BY 2 DESC",
    );
    return ev || 'Không có sự kiện nào 24h qua.';
  }
  return 'Tôi biết về Phòng Hai Người. Hỏi: "phiên đang mở", "số cặp đôi", hoặc "events 24h qua".';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/.well-known/agent-card.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(AGENT_CARD));
    return;
  }

  if (url.pathname === '/a2a' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      const text =
        rpc.params?.message?.parts?.map((p) => p.text ?? '').join(' ') ?? '';
      const reply = answer(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            id: `msg-${Date.now()}`,
            role: 'agent',
            parts: [{ kind: 'text', text: reply }],
          },
        }),
      );
    });
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: 'phn-buddy' }));
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[phn-buddy] listening on 127.0.0.1:${PORT}`);
});