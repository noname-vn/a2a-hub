# A2A Hub — xkd.vn

Hub registry + router cho các **Hermes agent** liên hệ nhau qua
[A2A Protocol](https://a2a-protocol.org) v1.0.0.

- 1 file `server.js` (~356 dòng), duy nhất 1 dependency `ws`, registry `registry.json`
- VPS 103.74.100.107, service `a2a-hub-min.service` :3211 (localhost) — public qua nginx TLS `https://a2a.xkd.vn`
- **KHÔNG chạy LLM** — hub thuần registry + router; agent cầm logic

## Endpoint công khai
- `GET https://a2a.xkd.vn/.well-known/agent-card.json` — AgentCard chuẩn A2A v1.0
- `POST https://a2a.xkd.vn/a2a` — JSON-RPC `SendMessage` (header: `Authorization: Bearer <key>`,
  `X-A2A-Target: <tên-agent-đích>`, `A2A-Version: 1.0`)
- `GET https://a2a.xkd.vn/health` — `{ok, agents_online}`
- `WS https://a2a.xkd.vn/agent-ws?token=<key>` — kênh agent sau NAT (không SSH)

## Registry (chỉ qua localhost trên VPS)
- `POST http://127.0.0.1:3211/registry` — đăng ký agent (body: `{name, url?}` → trả `api_key` 1 lần)
- `GET http://127.0.0.1:3211/registry` — danh sách
- Auth admin: `Authorization: Bearer <admin key>` — admin key trong `registry.json` (`_admin_key`)

## Agent đang đăng ký
- `phn-buddy` — HTTP agent trên VPS (:3210), trả lời trạng thái Phòng Hai Người
- `hermes-wsl` — WSL (WS client, handler test)
- `hermes-mac` — macOS (WS client, handler bọc hermes CLI)

## Thêm agent mới
1. Đăng ký (localhost VPS): `POST /registry` → nhận key
2. Agent sau NAT: chạy `agent-ws-client.js` (tự kết nối ra hub, không SSH)
   Agent cùng VPS: HTTP server nội bộ + đăng ký `url`
3. Gọi qua hub: `POST /a2a` với `X-A2A-Target: <name>`

Docs chi tiết: `docs/A2A_HUB.md` (triển khai A-Z) · `docs/A2A_CLIENT.md` (client agent)

## An toàn tối thiểu
Rate limit 60 req/phút · body 1MB · SSRF guard (agent.url chỉ nội bộ) ·
WS auth token=key · admin key 48 ký tự · `/registry` nginx chặn từ ngoài
