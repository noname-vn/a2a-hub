# A2A Hub — bản tối giản

> 1 file Node 220 dòng (`server-min.js`), duy nhất 1 dependency `ws`,
> registry = JSON file. Đủ cho: agents thấy nhau + nói chuyện qua hub.
> KHÔNG có: SDK A2A, DB, task lifecycle, streaming.

## An toàn tối thiểu (có sẵn)

- **Rate limit** 60 req/phút per caller — vượt trả 429
- **Body limit** 1MB — chặn OOM
- **SSRF guard** — agent.url chỉ chấp nhận loopback/private (không fetch URL public)
- **Admin key** mạnh 48 ký tự tự tạo, lưu `registry.json` (`_admin_key`)
- **/registry** cần admin key — reverse proxy phải chặn `/registry` từ ngoài

## Chạy

```bash
npm install ws
node server-min.js          # listen 127.0.0.1:3200 (đổi: PORT=xxxx node server-min.js)
```

- **Admin key**: tự tạo lần đầu, lưu trong `registry.json` (trường
  `_admin_key`) — đọc từ file, KHÔNG phải env
- Env: `PORT` (mặc định 3200)

## Endpoint

| | |
|---|---|
| `GET /health` | `{"ok":true, "agents_online":[...]}` |
| `GET /.well-known/agent-card.json` | card hub (tương thích A2A) |
| `POST /a2a` | JSON-RPC `message/send` — auth Bearer key agent, `X-A2A-Target: <tên>` |
| `POST /registry` | đăng ký agent (Bearer **admin key**): `{name, url?, skills?}` → `{api_key}` — key cấp 1 lần |
| `GET /registry` | danh sách (Bearer **admin key**) |
| `WS /agent-ws?token=<key>` | kênh agent — `hello` → nhận `task` → trả `result`; heartbeat ping/pong |

## Registry

File `registry.json` cạnh server (được ghi tự động khi hub khởi động lần
đầu — chứa `_admin_key`):

```json
{
  "_admin_key": "<ADMIN-KEY>",
  "ten-agent": {
    "url": "http://127.0.0.1:PORT/a2a",
    "skills": [],
    "key_hash": "sha256..."
  }
}
```

Đăng ký agent:

```bash
ADMIN_KEY=$(python3 -c "import json; print(json.load(open('registry.json'))['_admin_key'])")
curl -s -X POST http://127.0.0.1:3200/registry \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"ten-agent","url":"http://127.0.0.1:PORT/a2a"}'
```

## Agent phía WS (sau NAT — macOS/WSL/Windows)

```bash
# HUB_URL mặc định wss://a2a.xkd.vn/agent-ws — đổi nếu hub-min:
HUB_URL=<ws://hub:port/agent-ws> AGENT_NAME=<tên> API_KEY=<key> \
  node agent-ws-client.js ./handler.mjs
# handler.mjs: export default async (text) => "trả lời của agent"
```

## Agent HTTP (cùng máy VPS)

Server HTTP bất kỳ listen `127.0.0.1:<port>` nhận JSON-RPC
`message/send` → trả `{jsonrpc, id, result:{parts:[{kind:'text',text}]}}`.
Đăng ký qua `POST /registry` với `{name, url}`.

## TLS (nếu public Internet)

Hub listen 127.0.0.1 — phía trước cần reverse proxy TLS (nginx với
`Upgrade`/`Connection` headers cho `/agent-ws`, `proxy_buffering off`).
Chỉ nội bộ LAN/VPN: không cần, gọi thẳng `http://<ip>:3200`.

## Test E2E nhanh

```bash
KEY=<api-key-agent-gọi>
curl -s http://localhost:3200/a2a -H "Authorization: Bearer $KEY" \
  -H "X-A2A-Target: <agent>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send",
       "params":{"message":{"role":"user","parts":[{"kind":"text","text":"ping"}]}}}'
```

## Đã verify trên hệ thật

- [x] Đăng ký qua POST /registry (admin key từ registry.json)
- [x] HTTP agent: gọi hermes1 → Hermes CLI trả lời "10"
- [x] WS agent: hermes-mac online (không SSH), nhận task, trả result
- [x] Agent-to-agent: hermes1 ↔ hermes-mac qua hub
- [x] Health + AgentCard discovery