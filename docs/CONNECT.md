# Kết nối A2A Hub — xkd.vn

> Tài liệu cho **agent muốn tham gia / liên hệ qua A2A Hub**.
> Chuẩn: [A2A Protocol](https://a2a-protocol.org) v1.0 (HTTP(S) + JSON-RPC 2.0)
> Cập nhật: 17/09/2026

---

## 1. Thông tin hub

| | |
|---|---|
| **Endpoint A2A** | `https://a2a.xkd.vn/a2a` |
| **Agent Card hub** | `GET https://a2a.xkd.vn/.well-known/agent-card.json` |
| **Health** | `GET https://a2a.xkd.vn/health` → `{"ok":true,"service":"a2a-hub"}` |
| **Protocol** | A2A v1.0 (JSON-RPC 2.0 over HTTPS, SSE streaming hỗ trợ) |
| **Vai trò** | Registry + Router — hub KHÔNG chạy LLM, chỉ kết nối agent |

## 2. Xác thực

Mọi request tới `/a2a` cần header:

```
Authorization: Bearer <API-KEY-của-bạn>
X-A2A-Target: <tên-agent-đích>
A2A-Version: 1.0
```

- API key cấp **1 lần duy nhất** khi agent được đăng ký vào registry (bởi admin hub)
- `X-A2A-Target` = tên agent muốn liên hệ (xem danh sách agents bên dưới)

## 3. Gọi một agent

```bash
curl -s https://a2a.xkd.vn/a2a \
  -H "Authorization: Bearer <API-KEY>" \
  -H "X-A2A-Target: phn-buddy" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"kind": "text", "text": "phòng có bao nhiêu phiên đang mở?"}]
      }
    }
  }'
```

**Phản hồi** (JSON-RPC result chứa message của agent):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "msg-...",
    "role": "agent",
    "parts": [{"kind": "text", "text": "Phiên đang mở: 0. Thời lượng trung bình 24h qua: 1 phút."}]
  }
}
```

## 4. Agents đang đăng ký trong hub

### `hermes1` ⭐ LIVE

- **Vai trò**: Hermes agent đầy đủ (não LLM + tools) chạy trên WSL
- **Skills**: `hermes.chat` — chat, viết code, chạy lệnh WSL, truy vấn
- **Endpoint nội bộ**: `http://127.0.0.1:3221/a2a` (SSH tunnel từ WSL)
- **Trạng thái**: LIVE — đã verify `1+1=2` qua hub

### `hermes-mac` (chưa online)

- **Vai trò**: Hermes agent đa năng chạy trên macOS của chủ hub
- **Skills**: `hermes.chat` — agent đa năng
- **Endpoint nội bộ**: `http://127.0.0.1:3220/a2a` (qua SSH tunnel từ máy Mac,
  tunnel phải đang chạy mới gọi được)

### `phn-buddy`

- **Vai trò**: trả lời câu hỏi về Phòng Hai Người (rule-based, query DB read-only)
- **Skills**: `phn.room.status` — phiên đang mở, số cặp đôi, events 24h
- **Câu hỏi hiểu được**: "phiên đang mở", "số cặp đôi", "events 24h qua"
- **Endpoint nội bộ** (hub nhìn thấy, KHÔNG public): `http://127.0.0.1:3210/a2a`

## 5. Đăng ký agent mới (cho admin hub)

> Chỉ làm được trên VPS — endpoint `/registry/` bị nginx chặn từ ngoài.

```bash
# trên VPS:
curl -s -X POST http://127.0.0.1:3200/registry/agents \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "tên-agent",
    "card": {
      "name": "tên-agent",
      "url": "http://127.0.0.1:PORT/a2a",
      "skills": [{"id": "skill.id", "description": "..."}]
    }
  }'
```

→ trả `{"name": "...", "api_key": "..."}` — **lưu key ngay**, không xem lại được.

**Agent chạy ở máy cá nhân (WSL / macOS / Linux bất kỳ)**: dùng SSH reverse
tunnel để không mở port inbound:

```bash
ssh -N -R 3220:localhost:3220 root@103.74.100.107   # giữ chạy (macOS/WSL đều vậy)
```

— agent listen `127.0.0.1:3220` trên máy mình, đăng ký card với
`url: http://127.0.0.1:3220/a2a` (từ góc nhìn hub, tunnel chạy trên VPS —
`localhost:3220` của VPS forward về máy agent).

### Lấy API key

API key **không tự đăng ký được** — registry chỉ nhận từ localhost trên VPS
(bảo mật). Cách lấy:

1. Liên hệ admin hub (Truong Cao) — admin đăng ký agent + gửi lại key
2. Hoặc tự chạy lệnh đăng ký trên VPS (nếu có SSH): xem lệnh ở mục trên

Key cấp 1 lần duy nhất — lưu an toàn. Mất key → admin đăng ký lại tên agent
(cùng lệnh) → key mới.

## 6. Lưu ý

- Hub forward JSON-RPC **nguyên vẹn** tới agent đích — agent tự trả result
  theo format A2A (result.parts[].text)
- Rate limit / health-check tự gỡ agent offline: chưa triển khai (phase sau)
- Streaming SSE: hub đã tắt buffering, agent có `capabilities.streaming`
  thì client nhận stream pass-through
- Source hub: `github.com/noname-vn/a2a-hub`
- VPS: 103.74.100.107 (service `a2a-hub` :3200, `a2a-buddy` :3210)