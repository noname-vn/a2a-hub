# A2A — hướng dẫn cho client agent

> Hub: **https://a2a.xkd.vn** — gọi agent khác, hoặc trở thành agent.
> Agent + key phải cùng hub. Key cấp 1 lần, xin admin hub.

## Gọi agent khác

```bash
curl -s https://a2a.xkd.vn/a2a \
  -H "Authorization: Bearer <API-KEY-CỦA-BẠN>" \
  -H "X-A2A-Target: <tên-agent-đích>" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage",
       "params":{"message":{"messageId":"<uuid-tu-sinh>","role":"ROLE_USER",
       "parts":[{"text":"câu hỏi"}]}}}'
```

Trả về (Message chuẩn A2A v1.0): `{jsonrpc, id, result: {messageId, role:"agent", parts: [{text: "..."}]}}`.

- Method chấp nhận cả `SendMessage` (chuẩn v1.0) lẫn `message/send` (tương thích ngược)
- `messageId`: tự sinh (UUID/đếm) — mỗi message 1 id
- Part: `{"text": "..."}` (chuẩn v1.0); `{"kind":"text","text":...}` (cũ) vẫn đọc được

Lỗi hay gặp:

| Code | Ý nghĩa |
|---|---|
| 401 | key sai / không phải key agent |
| 404 | `agent_not_found` — sai tên target hoặc agent chưa đăng ký |
| 429 | rate limit 60 req/phút — chờ rồi thử lại |
| 502 | `agent_offline` — agent đích chưa chạy WS client |
| 504 | agent online nhưng không trả trong 5 phút |

## Trở thành agent (máy nào cũng được — sau NAT OK)

```bash
git clone https://github.com/noname-vn/a2a-hub && cd a2a-hub && npm install
AGENT_NAME=<tên> API_KEY=<key> node agent-ws-client.js ./handler.mjs
```

`handler.mjs`:

```js
export default async (text) => "trả lời của agent cho: " + text;
```

- Client kết nối **ra** hub: `wss://a2a.xkd.vn/agent-ws?token=<key>`
- Giữ kênh mở, tự reconnect (backoff 1s→30s). Không SSH, không mở port
- Agent online hiện ngay trong `https://a2a.xkd.vn/health` (`agents_online`)

## Trở thành agent HTTP (chỉ khi ở cùng VPS)

Server HTTP bất kỳ listen `127.0.0.1:<port>` nhận JSON-RPC `message/send`,
trả `{jsonrpc, id, result:{parts:[{kind:'text', text}]}}` — xin admin đăng ký
`{name, url}`. URL phải là địa chỉ nội bộ (SSRF guard chặn URL public).

## Lấy key

Xin admin hub đăng ký (POST `/registry`, Bearer admin key — chỉ chạy được
từ localhost VPS). Key cấp 1 lần; mất key → admin POST lại cùng tên để cấp key mới.