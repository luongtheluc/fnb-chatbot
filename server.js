/**
 * FnB Chatbot Server
 * POST /chat/stream — Gemini SSE streaming endpoint
 * POST /chat/session — Create new session
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { pool, testConnection } = require('./src/db');
const { streamChat } = require('./src/gemini-client');
const { getMenuContext, formatMenuForPrompt } = require('./src/menu-context');
const { buildSystemPrompt, buildGeminiHistory } = require('./src/prompt-builder');
const { validateInput, checkRateLimit, validateAiResponse } = require('./src/security');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: '*' })); // restrict in production
app.use(express.json({ limit: '10kb' }));

// Get real client IP (works behind proxy)
function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    '0.0.0.0'
  );
}

// ─── POST /chat/session ──────────────────────────────────────────────────────
// Create or validate a chat session
app.post('/chat/session', async (req, res) => {
  try {
    const sessionId = uuidv4();
    const ip = getClientIp(req);

    await pool.execute(
      `INSERT INTO chat_sessions (id, ip_address) VALUES (?, ?)`,
      [sessionId, ip]
    );

    res.json({ session_id: sessionId });
  } catch (err) {
    console.error('Session create error:', err.message);
    res.status(500).json({ error: 'Could not create session' });
  }
});

// ─── POST /chat/stream ───────────────────────────────────────────────────────
// Main streaming endpoint: SSE text/event-stream
app.post('/chat/stream', async (req, res) => {
  const { message, session_id } = req.body;
  const ip = getClientIp(req);

  // 1. Validate input
  const validation = validateInput(message);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  const cleanMessage = validation.cleaned;

  // 2. Validate session
  if (!session_id || typeof session_id !== 'string') {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  // 3. Rate limiting
  const rateCheck = await checkRateLimit(session_id, ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.reason });
  }

  // 4. Load conversation history (last 10 messages for context)
  let history = [];
  try {
    const [rows] = await pool.execute(
      `SELECT role, content FROM chat_messages
       WHERE session_id = ?
       ORDER BY created_at DESC LIMIT 10`,
      [session_id]
    );
    history = rows.reverse(); // oldest first
  } catch (err) {
    console.error('History load error:', err.message);
  }

  // 5. Load relevant menu context
  const menuItems = await getMenuContext(cleanMessage);
  const menuText = formatMenuForPrompt(menuItems);
  const systemPrompt = buildSystemPrompt(menuText);

  // 6. Build Gemini message history + new user message
  const geminiMessages = [
    ...buildGeminiHistory(history),
    { role: 'user', parts: [{ text: cleanMessage }] },
  ];

  // 7. Save user message to DB
  try {
    await pool.execute(
      `INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'user', ?)`,
      [session_id, cleanMessage]
    );
  } catch (err) {
    console.error('Save user message error:', err.message);
  }

  // 8. Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  // 9. Stream from Gemini
  let fullResponse = '';

  await streamChat(
    geminiMessages,
    systemPrompt,
    // onChunk
    (text) => {
      fullResponse += text;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    },
    // onDone
    async () => {
      // Validate AI response for jailbreak
      if (!validateAiResponse(fullResponse)) {
        console.warn('Suspicious AI response detected, session:', session_id);
        fullResponse = 'Xin lỗi, có lỗi xảy ra. Vui lòng thử lại.';
      }

      // Save bot response to DB
      try {
        await pool.execute(
          `INSERT INTO chat_messages (session_id, role, content) VALUES (?, 'assistant', ?)`,
          [session_id, fullResponse]
        );
        // Update session last_active
        await pool.execute(
          `UPDATE chat_sessions SET last_active = CURRENT_TIMESTAMP WHERE id = ?`,
          [session_id]
        );
      } catch (err) {
        console.error('Save bot message error:', err.message);
      }

      res.write('data: [DONE]\n\n');
      res.end();
    },
    // onError
    (err) => {
      console.error('Gemini stream error:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'AI service error. Please try again.' })}\n\n`);
      res.end();
    }
  );
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', model: 'gemini-2.0-flash' });
});

// ─── Start server ─────────────────────────────────────────────────────────────
async function start() {
  await testConnection();
  app.listen(PORT, () => {
    console.log(`🤖 Chatbot server running at http://localhost:${PORT}`);
  });
}

start();
