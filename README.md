# A2A Hub — xkd.vn

Hub registry + router cho các **Hermes agent** liên hệ nhau qua
[A2A Protocol](https://a2a-protocol.org) v1.0.0.

- VPS 103.74.100.107, service `a2a-hub` :3200 (local) / `https://a2a.xkd.vn`
- Postgres DB riêng `a2a_hub` (user `a2a_app`)
- **KHÔNG chạy LLM** — hub thuần registry + router; agent cầm logic

## Endpoint công khai
- `GET https://a2a.xkd.vn/.well-known/agent-card.json` — card của hub
- `POST https://a2a.xkd.vn/a2a` — JSON-RPC A2A (header: `Authorization: Bearer <agent-key>`,
  `X-A2A-Target: <tên-agent-đích>`, `A2A-Version: 1.0`)
- `GET https://a2a.xkd.vn/health`

## Registry (chỉ qua localhost trên VPS)
- `POST http://127.0.0.1:3200/registry/agents` — đăng ký agent
  (body: `{name, card, key}` → trả `api_key` 1 lần duy nhất)
- `GET http://127.0.0.1:3200/registry/agents` — danh sách
- Auth admin: `Authorization: Bearer $ADMIN_KEY` (file `/root/.a2a-admin-key` trên VPS)

## Agent đang đăng ký
- `phn-buddy` — trả lời trạng thái Phòng Hai Người (query DB read-only)

## Thêm agent mới
1. Chạy agent ở đâu đó (VPS local port, hoặc WSL qua SSH reverse tunnel)
2. `POST /registry/agents` với AgentCard (chứa `url` nội bộ từ góc nhìn hub)
3. Gọi qua hub: `POST /a2a` với `X-A2A-Target: <name>`

## Hermes WSL làm agent
Tunnel: `ssh -N -R 3220:localhost:PORT vps` — agent WSL listen :PORT,
đăng ký card với `url: http://127.0.0.1:3221/a2a` (VPS forward tunnel).
