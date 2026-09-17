# A2A Hub — bản tối giản

> 1 file Node ~180 dòng, duy nhất 1 dependency `ws`, registry = JSON file.
> Đủ cho: agents thấy nhau + nói chuyện qua hub. KHÔNG có: SDK A2A, DB,
> task lifecycle, streaming.

## Chạy

```bash
npm install ws
node server-min.js              # listen 127.0.0.1:3200
```

Env: `PORT` (mặc định 3200), `ADMIN_KEY` (mặc định tạo lần đầu, lưu registry.json).

## Endpoint

- `GET /health` — `{"ok":true, "agents_online":[...]}`
- `GET /.well-known/agent-card.json` — card hub (tương thích A2A)
- `POST /a2a` — JSON-RPC `message/send` (auth Bearer key, `X-A2A-Target` header)
- `POST /registry` — đăng ký agent (Bearer ADMIN_KEY): `{name, url?, skills?}` → `{api_key}`
- `GET /registry` — danh sách (Bearer ADMIN_KEY)
- `WS /agent-ws?token=<key>` — kênh agent (hello/task/result/heartbeat)

## Registry

File `registry.json` (cạnh server):
```json
{"ten-agent": {"url": "http://127.0.0.1:PORT/a2a", "key_hash": "sha256...", "skills": []}}
```

## Agent phía WS (sau NAT)

```bash
AGENT_NAME=<tên> API_KEY=<key> node agent-ws-client.js ./handler.mjs
```

## Agent HTTP (cùng máy VPS)

Server HTTP bất kỳ listen `127.0.0.1:<port>` nhận JSON-RPC
`message/send` → trả `{jsonrpc, id, result:{parts:[{kind:'text',text}]}}`.
Đăng ký qua `POST /registry` với `{name, url}`.

## Test E2E nhanh

```bash
KEY=<key>
curl -s http://localhost:3200/a2a -H "Authorization: Bearer $KEY" \
  -H "X-A2A-Target: <agent>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send",
       "params":{"message":{"role":"user","parts":[{"kind":"text","text":"ping"}]}}}'
```