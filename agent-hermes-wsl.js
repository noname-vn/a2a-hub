/**
 * Hermes-WSL A2A endpoint — expose Hermes CLI qua A2A (JSON-RPC) để các
 * agent khác (hermes-mac...) gọi qua hub a2a.xkd.vn.
 *
 * Luồng: POST /a2a {message/send, parts[].text} → chạy `hermes -p "<text>"`
 * → trả result.parts[].text.
 *
 * Bảo mật: listen 127.0.0.1 (chỉ tunnel SSH tới được); xác thực hub-side
 * (registry key); lệnh chạy cục bộ trên WSL.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';

const PORT = process.env.PORT || 3221;
const HERMES_BIN = process.env.HERMES_BIN || '/opt/hermes/bin/hermes';
const TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT || 180_000);

const AGENT_CARD = {
  name: 'hermes1',
  description: 'Hermes agent trên WSL — đầy đủ não LLM + tools',
  version: '1.0.0',
  protocolVersion: '1.0',
  url: `http://127.0.0.1:${PORT}/a2a`,
  capabilities: { streaming: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [
    {
      id: 'hermes.chat',
      name: 'Hermes agent',
      description: 'Đa năng: chat, viết code, chạy lệnh hệ thống WSL, truy vấn',
    },
  ],
};

/** Chạy hermes CLI với prompt — trả stdout */
function runHermes(prompt) {
  return new Promise((resolve) => {
    execFile(
      process.env.HERMES_BIN || '/opt/hermes/bin/hermes',
      ['-z', prompt],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve(`[hermes lỗi] ${stderr || err.message}`.slice(0, 800));
        } else {
          resolve((stdout || stderr || '').trim().slice(0, 4000));
        }
      },
    );
  });
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
    req.on('end', async () => {
      let rpc;
      try {
        rpc = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const text =
        rpc.params?.message?.parts?.map((p) => p.text ?? '').join(' ') ?? '';
      console.log(`[hermes1] prompt: ${text.slice(0, 80)}`);
      const reply = await runHermes(text);
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
    res.end(JSON.stringify({ ok: true, agent: 'hermes1' }));
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[hermes1] listening on 127.0.0.1:${PORT}`);
});