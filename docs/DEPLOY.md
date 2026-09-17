# Triển khai A2A Hub — A đến Z (bản gọn)

> 1 file `server.js` (~250 dòng) + duy nhất 1 dependency `ws` + registry `registry.json`.
> Đang chạy thật tại **https://a2a.xkd.vn** (VPS 103.74.100.107).

## Kiến trúc

```
Internet ──TLS──→ nginx :443 (a2a.xkd.vn)
                    │  location /  → 127.0.0.1:3211 (server.js — systemd a2a-hub-min)
                    │  /registry   → DENY từ ngoài (đăng ký chỉ qua localhost)
                    │  /agent-ws   → WS kênh agent (Upgrade headers)
                    └─ agent HTTP cùng VPS: phn-buddy :3210
```

- **Agent sau NAT** (Mac/WSL/Windows): không cần SSH, không cần mở port — chạy client
  `agent-ws-client.js` kết nối **ra** hub bằng API key
- **Agent cùng VPS**: HTTP server nội bộ, đăng ký `{name, url}`

## An toàn có sẵn

| Biện pháp | Chi tiết |
|---|---|
| Rate limit | 60 req/phút per caller → 429 |
| Body limit | 1MB → 413 |
| SSRF guard | agent.url chỉ chấp nhận loopback/private |
| WS auth | token=key trong URL, name phải khớp agent sở hữu key; sai → destroy |
| Admin key | 48 ký tự tự tạo, lưu `registry.json` (`_admin_key`) |
| /registry | Bearer admin key, nginx chặn từ ngoài |

## Bước 1 — VPS (Ubuntu, Node 20)

```bash
apt install -y nodejs nginx
mkdir -p /opt/a2a-hub && cd /opt/a2a-hub
# copy server.js, agent-ws-client.js, agent-phn-buddy.js (tùy agent)
npm install        # cài ws
```

## Bước 2 — chạy hub

```bash
# hub listen 127.0.0.1:3211 (đổi: PORT=xxx node server.js)
cat > /etc/systemd/system/a2a-hub-min.service <<EOF
[Unit]
Description=A2A Hub
After=network.target
[Service]
WorkingDirectory=/opt/a2a-hub
Environment=PORT=3211
ExecStart=/usr/bin/node /opt/a2a-hub/server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now a2a-hub-min
curl http://127.0.0.1:3211/health   # → {"ok":true,"agents_online":[]}
```

Lần chạy đầu tự tạo `registry.json` với `_admin_key` (48 ký tự) — **đọc ngay và lưu**:

```bash
python3 -c "import json; print(json.load(open('/opt/a2a-hub/registry.json'))['_admin_key'])"
```

## Bước 3 — nginx TLS

```nginx
server {
    listen 443 ssl http2;
    server_name a2a.xkd.vn;
    ssl_certificate     /etc/letsencrypt/live/a2a.xkd.vn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/a2a.xkd.vn/privkey.pem;

    location /registry/ {
        deny all;                    # đăng ký agent chỉ qua localhost
    }
    location / {
        proxy_pass http://127.0.0.1:3211;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # WS
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
server {
    listen 80;
    server_name a2a.xkd.vn;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}
```

```bash
nginx -t && systemctl reload nginx
```

## Bước 4 — đăng ký agent (localhost VPS)

```bash
ADMIN=$(python3 -c "import json; print(json.load(open('/opt/a2a-hub/registry.json'))['_admin_key'])")
# Agent HTTP cùng VPS (có url):
curl -s -X POST http://127.0.0.1:3211/registry \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"phn-buddy","url":"http://127.0.0.1:3210/a2a"}'
# Agent sau NAT (WS client):
curl -s -X POST http://127.0.0.1:3211/registry \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"hermes-mac"}'
# → {"name":"...","api_key":"<KEY CẤP 1 LẦN>"}
```

Key đã cấp mà mất: POST cùng tên → key mới (key cũ chết ngay).

## Bước 5 — nghiệm thu E2E

```bash
# 1. Health từ ngoài:
curl https://a2a.xkd.vn/health
# 2. /registry từ ngoài PHẢI bị chặn:
curl -o /dev/null -w "%{http_code}\n" https://a2a.xkd.vn/registry   # expect 403
# 3. WS key sai PHẢI bị chặn (client node + ws lib, expect destroy)
# 4. Gọi agent (thay <KEY>):
curl -s https://a2a.xkd.vn/a2a -H "Authorization: Bearer <KEY>" \
  -H "X-A2A-Target: <agent>" -H "A2A-Version: 1.0" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"ping"}]}}}'
# 5. Agents online hiện đúng sau khi WS client chạy
```

## Vận hành

```bash
systemctl status a2a-hub-min      # hub
journalctl -u a2a-hub-min -f      # log
nano /opt/a2a-hub/registry.json && systemctl restart a2a-hub-min   # sửa registry (load 1 lần lúc start!)
```