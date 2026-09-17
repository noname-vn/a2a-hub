# Triển khai A2A Hub từ A đến Z

> Tài liệu đầy đủ để dựng lại **toàn bộ hệ thống A2A Hub** trên một VPS mới
> (hoặc phục vụ/tái hiện hệ thống hiện có tại `a2a.xkd.vn`).
> Chuẩn: [A2A Protocol](https://a2a-protocol.org) v1.0 (Apache 2.0, Linux Foundation)
> Phiên bản tài liệu: 1.0 — 17/09/2026 — đã verify trên VPS Ubuntu 22.04

---

## 0. Tổng quan hệ thống

```
Agent A (máy cá nhân, sau NAT) ──WS outbound──┐
Agent B (máy cá nhân) ────────────────────────┤
                                              ▼
                              ┌──────────────────────────┐
   Client (HTTP JSON-RPC) ──→ │  A2A Hub :3200           │
                              │  • Registry (Postgres)   │
                              │  • Router (WS + HTTP)    │
                              │  • Auth (API key)        │
                              └──────────┬───────────────┘
                                         │
                    Agent HTTP (VPS local)├─ Agent WS (máy cá nhân)
```

**Ba vai trò:**
- **Hub** — server trung tâm: lưu danh sách agent (registry), nhận request
  từ client, route tới agent đích qua WS (agent sau NAT) hoặc HTTP (agent
  chạy cùng máy hub). **Không chạy LLM.**
- **Agent** — thực thi công việc. 2 kiểu:
  - *HTTP agent*: chạy cùng máy VPS, hub fetch trực tiếp tới `127.0.0.1:port`
  - *WS agent*: chạy ở máy cá nhân sau NAT, tự kết nối **ra** hub bằng
    WebSocket (không cần SSH, không cần IP public)
- **Client** — bất kỳ chương trình nào gọi agent qua hub (agent khác,
  script, app)

**Yêu cầu tài nguyên**: VPS 1 vCPU/1GB là đủ (hub ~50MB RAM). Không cần GPU,
không cần LLM API key.

**Chi phí**: 0₫ (hub thuần router; LLM chạy phía agent, agent tự lo API key
của mình).

---

## 1. Chuẩn bị VPS

Yêu cầu: Ubuntu 20.04+, Node.js 20+, nginx, Postgres 14+, domain trỏ A record
về VPS (VD: `a2a.yourdomain.com`).

```bash
# Node 20 (nếu chưa có):
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs

# Postgres 14 (nếu chưa có):
apt-get install -y postgresql postgresql-contrib

# nginx:
apt-get install -y nginx
```

DNS: tạo A record `a2a.<domain-của-bạn>` → IP VPS. Kiểm tra:
```bash
dig +short a2a.yourdomain.com   # phải trả IP VPS
```

---

## 2. Cài đặt Hub

### 2.1. Thư mục + dependencies

```bash
mkdir -p /opt/a2a-hub && cd /opt/a2a-hub
npm init -y
npm install @a2a-js/sdk@^1.1.0 pg ws
# set "type": "module" trong package.json!
```

### 2.2. Source code

3 file (nguồn đầy đủ ở repo `github.com/noname-vn/a2a-hub`):

| File | Vai trò |
|---|---|
| `server.js` | Hub: HTTP JSON-RPC router + Registry API + **WS server `/agent-ws`** |
| `db.js` | Postgres pool (DB riêng) |
| `agent-phn-buddy.js` | Agent demo HTTP (tùy chọn) |

**Cơ chế chính của hub** (để hiểu trước khi triển khai):

- **Registry**: bảng `agents` (name, agent_card jsonb, api_key_hash, enabled,
  last_seen). Đăng ký chỉ nhận từ `127.0.0.1` (nginx chặn `/registry/` từ
  ngoài) — key API cấp 1 lần, lưu **hash sha256**.
- **Router HTTP**: client `POST /a2a` với header `X-A2A-Target: <agent-name>`
  → hub tra registry → nếu agent đang **online qua WS** → đẩy task qua WS
  (timeout 300s); nếu không → fetch tới `agent_card.url` (HTTP agent).
- **WS channel `/agent-ws?token=<api-key>`**: agent kết nối ra (outbound),
  gửi `{"type":"hello","name":"..."}` — name **phải khớp** agent sở hữu key
  (chống giả mạo). Hub đẩy task `{type:"task", rpc}` — agent trả
  `{type:"result", rpc}`. Heartbeat `{type:"ping"}`/`{type:"pong"}` mỗi 25s.
- **Auth 2 lớp**: token query = api key của agent + name khớp agent đó.
- **Health**: `GET /health` → `{"ok":true, "agents_online": [...]}`

### 2.3. Database riêng

```bash
sudo -u postgres psql -c "CREATE USER a2a_app WITH PASSWORD '<MẬT-KHẨU-MỚI>';"
sudo -u postgres createdb -O a2a_app a2a_hub
```

Schema tự tạo khi hub khởi động lần đầu (bảng `agents`).

### 2.4. Environment + systemd

```bash
ADMIN_KEY=$(openssl rand -hex 24)      # key quản trị registry
mkdir -p /etc/systemd/system/a2a-hub.service.d
cat > /etc/systemd/system/a2a-hub.service.d/env.conf <<EOF
[Service]
Environment=DATABASE_URL=postgres://a2a_app:<MẬT-KHẨU>@127.0.0.1:5432/a2a_hub
Environment=ADMIN_KEY=$ADMIN_KEY
EOF
# LƯU ADMIN_KEY: echo "ADMIN_KEY=$ADMIN_KEY" > /root/.a2a-admin-key && chmod 600 /root/.a2a-admin-key
```

```ini
# /etc/systemd/system/a2a-hub.service
[Unit]
Description=A2A Hub — registry + router
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/a2a-hub
ExecStart=/usr/bin/node /opt/a2a-hub/server.js
Restart=on-failure
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now a2a-hub
curl -s http://127.0.0.1:3200/health   # {"ok":true,...}
```

---

## 3. nginx + TLS

```nginx
# /etc/nginx/sites-available/a2a
server {
    listen 80;
    server_name a2a.yourdomain.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl http2;
    server_name a2a.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/a2a.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/a2a.yourdomain.com/privkey.pem;

    # Registry — KHÔNG công khai
    location /registry/ { deny all; }

    # WebSocket kênh agent (auth bằng token query)
    location /agent-ws {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        proxy_buffering off;   # SSE pass-through
    }
}
```

```bash
ln -sf /etc/nginx/sites-available/a2a /etc/nginx/sites-enabled/
certbot certonly --nginx -d a2a.yourdomain.com --non-interactive --agree-tos
nginx -t && systemctl reload nginx
curl -s https://a2a.yourdomain.com/health
curl -s https://a2a.yourdomain.com/.well-known/agent-card.json
```

---

## 4. Đăng ký agent + cấp key

> Chỉ làm được trên VPS (nginx chặn `/registry/` từ ngoài).

```bash
ADMIN_KEY=$(grep ADMIN_KEY /root/.a2a-admin-key | cut -d= -f2)
curl -s -X POST http://127.0.0.1:3200/registry/agents \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ten-agent",
    "card": {
      "name": "ten-agent",
      "url": "http://127.0.0.1:PORT/a2a",   // HTTP agent: port local trên VPS
      "skills": [{"id": "skill.id", "description": "mô tả"}]
    }
  }'
```

→ `{"name":"ten-agent","api_key":"<64-hex>"}` — **cấp 1 lần, lưu ngay**.
Mất key: chạy lại lệnh trên (cùng name) → key mới thay key cũ.

---

## 5. Triển khai Agent

### 5A. HTTP agent (chạy trên VPS)

Sample: `agent-phn-buddy.js` — http server listen `127.0.0.1:<PORT>`,
expose:
- `GET /.well-known/agent-card.json` — card của agent
- `POST /a2a` — nhận JSON-RPC `{method:'message/send', params:{message:{parts}}}`
  → xử lý → trả `{jsonrpc:'2.0', id, result:{parts:[{kind:'text',text}]}}`
- `GET /health`

systemd unit tương tự hub (`a2a-<tên>.service`, `MemoryMax=128M`).
Đăng ký với `url: http://127.0.0.1:<port>/a2a`.

### 5B. WS agent (máy cá nhân sau NAT — macOS/WSL/Windows)

Dùng sample `agent-ws-client.js` trong repo:

```bash
cd a2a-hub && npm install ws
# handler — logic của agent:
cat > my-handler.mjs <<'EOF'
export default async (text) => {
  // TODO: logic agent của bạn (gọi Hermes CLI, LLM API, tool...)
  return `Trả lời cho: ${text}`;
};
EOF

AGENT_NAME=ten-agent API_KEY=<key> node agent-ws-client.js ./my-handler.mjs
```

- Kết nối `wss://<hub>/agent-ws?token=<key>`, hello, nhận task, trả result
- Tự reconnect (backoff 1s→30s), heartbeat 25s
- **KHÔNG cần SSH, KHÔNG cần IP public, KHÔNG cần mở port**

Đăng ký card với `url` không quan trọng lắm với WS agent (hub ưu tiên WS
khi online) — nhưng vẫn nên đặt để có tài liệu.

### 5C. Agent = Hermes (não LLM thật)

Sample `agent-hermes-wsl.js`: bọc CLI Hermes:

```js
execFile('/opt/hermes/bin/hermes', ['-z', prompt], {timeout: 180_000}, ...)
```

- `-z PROMPT` là flag prompt của Hermes (KHÔNG phải `-p`)
- Hermes chạy qua docker shim → dùng **đường dẫn tuyệt đối** `/opt/hermes/bin/hermes`
- Listen `127.0.0.1:3221` + tunnel nếu cần: `ssh -N -R 3221:localhost:3221 vps`

---

## 6. Client gọi agent

```bash
curl -s https://a2a.yourdomain.com/a2a \
  -H "Authorization: Bearer <API-KEY-GỌI>" \
  -H "X-A2A-Target: <tên-agent-đích>" \
  -H "A2A-Version: 1.0" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send",
       "params":{"message":{"role":"user",
       "parts":[{"kind":"text","text":"câu hỏi"}]}}}'
```

Phản hồi: `{jsonrpc, id, result: {parts: [{kind:'text', text: "..."}]}}`.

Mọi agent đều gọi agent khác bằng cùng cách này (đổi key + target).

---

## 7. Agent ↔ Agent (agent-to-agent)

Agent A muốn hỏi agent B: A dùng **API key của A**, `X-A2A-Target: <B>`,
thân message là nội dung cần B xử lý. Kết quả B trả về A ở
`result.parts[].text`. A có thể parse và tiếp tục suy luận.

---

## 8. Vận hành

| Việc | Lệnh |
|---|---|
| Trạng thái hub | `systemctl status a2a-hub` |
| Log hub | `journalctl -u a2a-hub -f` |
| Agents online | `curl -s https://a2a.yourdomain.com/health \| jq .agents_online` |
| Danh sách registry | `curl -s http://127.0.0.1:3200/registry/agents -H "Authorization: Bearer $ADMIN_KEY"` |
| Reset key agent | Chạy lại POST `/registry/agents` cùng name |
| Hub restart | `systemctl restart a2a-hub` (WS agent tự reconnect) |

**Rủi ro đã biết:**
- RAM hub ~50MB — an toàn trên VPS 1GB+
- WS agent offline khi máy tắt — hub trả `agent_offline` cho client (không treo)
- Chưa có: rate limit per key, persistent task queue (task trong lúc agent
  offline sẽ fail — phase sau), audit log

---

## 9. Checklist nghiệm thu (đã verify trên hệ hiện có)

- [x] `GET /health` → `{"ok":true}`
- [x] `GET /.well-known/agent-card.json` → card đúng format A2A
- [x] Registry POST/GET qua localhost + admin key
- [x] HTTP agent (phn-buddy) — client → hub → agent → trả lời DB
- [x] WS agent sau NAT (hermes-mac macOS) — online qua WS, nhận task, trả result
- [x] Agent-to-agent: hermes1 (WSL, Hermes thật + tools) gọi hermes-mac
      (macOS, Hermes thật + tools) qua hub — trả lời có nội dung thật
- [x] nginx TLS + certbot riêng cho subdomain
- [ ] Rate limit per key (phase sau)
- [ ] Persistent task queue (phase sau)

---

## 10. Cấu trúc repo tham khảo

```
github.com/noname-vn/a2a-hub
├── server.js            # hub (registry + router + WS server)
├── db.js                # pg pool
├── agent-phn-buddy.js   # HTTP agent demo
├── agent-hermes-wsl.js  # WS→Hermes CLI bridge
├── agent-ws-client.js   # sample WS client cho agent cá nhân
├── docs/CONNECT.md      # tài liệu ngắn cho agent kết nối
└── docs/DEPLOY.md       # tài liệu này
```

License: MIT. Protocol: A2A v1.0 (Apache 2.0 — the Linux Foundation).