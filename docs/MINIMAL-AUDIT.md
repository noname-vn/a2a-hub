# Audit: yêu cầu tối thiểu của A2A Hub

> So sánh hệ đang chạy (17/09) với yêu cầu tối thiểu thật sự — dựa trên
> **những gì được dùng thật**, không phải lý thuyết chuẩn.

## 1. Hệ hiện tại dùng được gì (bằng chứng E2E)

3 tính năng đã chạy thật và được verify:

1. **Registry** — đăng ký agent + cấp API key (hash lưu DB)
2. **Router HTTP** — client gọi `/a2a` → hub fetch tới HTTP agent trên VPS
3. **Router WS** — client gọi `/a2a` → hub đẩy task qua WebSocket tới agent
   sau NAT → agent trả result

Không có tính năng nào khác được dùng.

## 2. Những thứ đang DƯ ("giết gà bằng dao mổ trâu")

| Thành phần | Trạng thái | Bằng chứng | Thay thế tối giản |
|---|---|---|---|
| **`@a2a-js/sdk`** (17 packages, 6.1MB node_modules) | **Cài nhưng KHÔNG import** — grep toàn bộ source: 0 tham chiếu. Chỉ có trong package.json cho "đúng chuẩn" | Dư 100% | Xóa — hub tự nói JSON-RPC bằng ~40 dòng |
| **Postgres + pg driver** (8 pool.query, 1 bảng vài dòng) | Registry chỉ cần name→key+url; dữ liệu nhỏ, ít thay đổi | Dư kiến trúc | 1 file JSON `/opt/a2a-hub/registry.json` (đọc/ghi đồng bộ) — bỏ DB, bỏ user DB, bỏ backup DB |
| **Streaming SSE trong AgentCard** (`capabilities.streaming: true`) | KHÔNG agent nào dùng streaming thật — chỉ ghi trong card | Dư | Bỏ khỏi card, hoặc ghi `false` |
| **Push notifications field** | KHÔNG dùng | Dư | Bỏ |
| **Task lifecycle đầy đủ A2A** (submitted→working→completed, contextId, artifacts...) | Hệ chỉ dùng `message/send` + trả **text ngay** — mọi agent đều synchronous | Dư — đây là 80% độ phức tạp của spec A2A thật | Chỉ giữ `message/send` → result |
| **`@a2a-js` protocol format nghiêm ngặt** | Client của mình tự tạo — chỉ cần JSON hợp lệ | Gánh spec | JSON-RPC 2.0 thuần (vẫn tương thích wire format A2A) |
| **MemoryMax=256M + RAM hub 61MB** | Đo được 61MB RSS; phiên bản tối giản (bỏ pg) ước ~35-40MB | Gần tối ưu | OK giữ |

**Không dư** (cần thật):
- `ws` package (WS channel — phương án 1 không SSH) — 2 file, bắt buộc
- nginx + TLS: **CẦN nếu hub public** (API key đi qua mạng). Nếu hub chỉ
  nội bộ VPN/LAN → HTTP thuần, bỏ luôn nginx+certbot
- 335 dòng server.js: ~40% là registry HTTP API + WS handshake an toàn
  (name-matching chống giả mạo) — cần thật nếu multi-agent nhiều người

## 3. Yêu cầu tối thiểu THẬT SỰ (conclusion)

Để **các Hermes agent thấy nhau + nói chuyện với nhau** chỉ cần:

1. **1 process Node duy nhất, 1 file ~180 dòng, duy nhất 1 dependency `ws`**
   — HTTP JSON-RPC router + WS kênh agent
2. **Registry = 1 file JSON** (name → {key_hash, url}) — đọc/ghi đồng bộ
3. **API key** — hash sha256, cấp 1 lần
4. **TLS** — chỉ khi client ngoài Internet; nội bộ/LAN không cần

**Không cần**: A2A SDK, Postgres, Task lifecycle, Artifacts, streaming,
push notifications, gRPC/REST bindings của spec.

Ước lượng sau dọn: **1 file ~180 dòng, node_modules ~0.5MB, RAM ~35MB**.

## 4. Trade-off cần biết trước khi cắt

| Bỏ | Mất gì | Nhận lại |
|---|---|---|
| `@a2a-js/sdk` | Không bao giờ dùng được type từ SDK (mình tự định nghĩa wire format) | -6MB, 0 deps lạ |
| Postgres | Registry mất khi VPS chết (registry chỉ vài dòng JSON — dễ backup tay) | Đơn giản hóa vận hành 50% |
| Task lifecycle | Không track task dài (nước đi async, human-in-the-loop) | Code 1/2, đọc 1/2 |
| Streaming | Real-time updates | Chưa ai cần |
| A2A chuẩn nghiêm ngặt | Client SDK A2A chuẩn khác có thể không tương tác được | Wire format vẫn JSON-RPC — tương thích cao |

## 5. Đề xuất

- **Giữ nguyên hệ đang chạy** (đang live, đang serve hermes-mac) — không
  phá khi đang dùng
- Làm **phiên bản tối giản** song song (`server-min.js`, ~180 dòng, JSON
  registry) để so sánh — nếu chạy tốt qua 1 tuần → chuyển hẳn, bỏ sdk + pg
- Cập nhật DEPLOY.md: phần "tối giản" và phần "đầy đủ" tách rõ, người mới
  chỉ cần đọc phần tối giản