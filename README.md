# MeowTea Chatbot Server

AI chatbot tư vấn đồ uống — Node.js + Gemini streaming + MySQL.

## Kiến trúc

```
chat-widget.html  →  Node.js :3001  →  Gemini Flash  →  meowtea_schema (MySQL)
```

## Cài đặt

```bash
# 1. Tạo chatbot tables (chạy 1 lần)
mysql -u root -p meowtea_schema < database-schema.sql

# 2. Cấu hình
cp .env.example .env
# Sửa .env: điền GEMINI_API_KEY và DB credentials

# 3. Chạy
npm install
npm start        # production
npm run dev      # development (auto-reload)
```

## Lấy API Key

Vào **https://aistudio.google.com/apikey** → Create API key.
⚠️ Dùng key từ AI Studio, KHÔNG dùng key từ Google Cloud Console.

## API Endpoints

| Method | Path | Mô tả |
|--------|------|--------|
| `POST` | `/chat/session` | Tạo session mới, trả về `session_id` |
| `POST` | `/chat/stream` | Gửi tin nhắn, nhận SSE stream |
| `GET`  | `/health` | Health check |

### POST /chat/stream

```json
// Request
{ "message": "Có trà sữa không?", "session_id": "uuid-here" }

// Response: text/event-stream
data: {"text": "Dạ MeowTea"}
data: {"text": " có nhiều loại"}
data: [DONE]
```

## Cấu trúc file

```
chatbot-server/
├── server.js              — Express app, routes
├── src/
│   ├── db.js              — MySQL connection pool
│   ├── gemini-client.js   — Gemini API wrapper (stream + fallback)
│   ├── menu-context.js    — Query SanPham theo keyword
│   ├── prompt-builder.js  — Build system prompt
│   └── security.js        — Rate limit + injection filter
├── chat-widget.html        — Floating chatbot UI (test độc lập)
├── database-schema.sql     — Chatbot tables (thêm vào meowtea_schema)
└── .env.example
```

## Bảo mật

- Rate limit: 20 msg/phút/session, 100 msg/giờ/IP
- Prompt injection filter: 10+ patterns
- Input: max 500 ký tự, strip HTML
- API key: chỉ trong `.env`, không bao giờ expose ra client

## Mô hình AI

Auto-fallback: `gemini-flash-latest` → `gemini-2.0-flash` → `gemini-1.5-flash` → `gemini-1.5-flash-8b`
