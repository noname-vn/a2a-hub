/**
 * Sample: agent kết nối A2A Hub qua WebSocket — KHÔNG cần SSH, KHÔNG cần
 * public URL. Dùng cho agent sau NAT (macOS/Windows/Linux cá nhân).
 *
 * Chạy: AGENT_NAME=<tên> API_KEY=<key> node agent-ws-client.js --handler ./my-handler.js
 *
 * Handler (my-handler.js): module.exports = async (text) => "trả lời"
 *
 * Luồng: kết nối wss://a2a.xkd.vn/agent-ws?token=<key> → hello → nhận task
 * → xử lý bằng handler → gửi result về hub → hub trả client gọi.
 */
import WebSocket from 'ws';

const HUB = process.env.HUB_URL || 'wss://a2a.xkd.vn/agent-ws';
const NAME = process.env.AGENT_NAME;
const KEY = process.env.API_KEY;
const HANDLER_PATH = process.argv[2];

if (!NAME || !KEY || !HANDLER_PATH) {
  console.error('Cần: AGENT_NAME, API_KEY env + handler path (argv[2])');
  process.exit(1);
}

const { default: handler } = await import(HANDLER_PATH);

let ws = null;
let backoff = 1000;

function connect() {
  ws = new WebSocket(`${HUB}?token=${KEY}`);
  ws.on('open', () => {
    backoff = 1000;
    ws.send(JSON.stringify({ type: 'hello', name: NAME }));
    console.log(`[ws] connected as ${NAME}`);
  });
  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      console.log(`[ws] welcome: ${msg.name}`);
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type === 'task' && msg.rpc) {
      const text =
        msg.rpc.params?.message?.parts?.map((p) => p.text ?? '').join(' ') ?? '';
      let result;
      try {
        const answer = await handler(text);
        result = {
          id: `msg-${Date.now()}`,
          role: 'agent',
          parts: [{ kind: 'text', text: String(answer) }],
        };
      } catch (e) {
        result = { error: { message: String(e).slice(0, 200) } };
      }
      ws.send(JSON.stringify({ type: 'result', rpc: { ...msg.rpc, result } }));
    }
  });
  ws.on('close', () => {
    console.log(`[ws] closed — reconnect sau ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
  ws.on('error', () => {});
  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
  }, 25_000);
  ws.on('close', () => clearInterval(ping));
}

connect();