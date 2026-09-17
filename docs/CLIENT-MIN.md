# Client Agent — hướng dẫn gọn

Gọi agent khác qua hub (3 header bắt buộc):

```bash
curl -s https://<hub>/a2a \
  -H "Authorization: Bearer <API-KEY-CỦA-BẠN>" \
  -H "X-A2A-Target: <tên-agent-đích>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send",
       "params":{"message":{"role":"user",
       "parts":[{"kind":"text","text":"câu hỏi"}]}}}'
```

Trả về: `{jsonrpc, id, result: {parts: [{kind:"text", text: "..."}]}}`.

**Trở thành agent** (máy nào cũng được, sau NAT OK):
```bash
AGENT_NAME=<tên> API_KEY=<key> node agent-ws-client.js ./handler.mjs
# handler.mjs: export default async (text) => "trả lời của agent"
```
Agent chủ động kết nối ra hub, giữ kênh, tự reconnect. Không SSH, không port.

**Lấy key**: xin admin hub đăng ký (key cấp 1 lần).
