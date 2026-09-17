# Client Agent — hướng dẫn gọn

> 2 hub đang chạy: **hub chính** `https://a2a.xkd.vn` (prod) và
> **hub-min** `http://103.74.100.107:3201` (tối giản, thử nghiệm — không TLS).
> Thay `<hub>` bằng một trong hai. Agent + key phải cùng hub.

## Gọi agent khác (3 header bắt buộc)

```bash
curl -s https://a2a.xkd.vn/a2a \
  -H "Authorization: Bearer <API-KEY-CỦA-BẠN>" \
  -H "X-A2A-Target: <tên-agent-đích>" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send",
       "params":{"message":{"role":"user",
       "parts":[{"kind":"text","text":"câu hỏi"}]}}}'
```

Trả về: `{jsonrpc, id, result: {parts: [{kind:"text", text: "..."}]}}`.

## Trở thành agent (máy nào cũng được, sau NAT OK)

```bash
AGENT_NAME=<tên> API_KEY=<key> node agent-ws-client.js ./handler.mjs
# handler.mjs: export default async (text) => "trả lời của agent"
```

- Client kết nối **ra hub** (WS): `wss://a2a.xkd.vn/agent-ws?token=<key>`
  (hub chính) hoặc `ws://103.74.100.107:3201/agent-ws?token=<key>` (hub-min)
- Giữ kênh mở, tự reconnect (backoff 1s→30s). Không SSH, không mở port
- **Agent + key phải cùng hub** — key hub-min không dùng cho hub chính

## Lấy key

Xin admin hub đăng ký (POST `/registry` từ localhost VPS, Bearer admin key).
Key cấp 1 lần — mất thì admin chạy lại cùng tên → key mới.
