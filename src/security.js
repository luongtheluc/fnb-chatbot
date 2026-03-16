/**
 * Security middleware
 * - Input sanitization & validation
 * - Prompt injection detection
 * - Rate limiting via MySQL
 */

const { pool } = require('./db');

// Rate limit config
const RATE_LIMIT = {
  perSession: { max: 20, windowSec: 60 },   // 20 msg/min per session
  perIp: { max: 100, windowSec: 3600 },      // 100 msg/hour per IP
};

// Prompt injection patterns
const INJECTION_PATTERNS = [
  /ignore\s+(previous|prior|all|the)\s+instruction/i,
  /forget\s+(your\s+)?(previous|prior|all)?\s*(instruction|rule|prompt)/i,
  /you\s+are\s+now\s+(a|an)/i,
  /act\s+as\s+(a|an|if)/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /new\s+(role|persona|instruction|prompt|system)/i,
  /system\s*prompt/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /override\s+(your|all)\s*(instruction|rule|setting)/i,
];

/**
 * Sanitize and validate user input
 * @param {string} input
 * @returns {{ ok: boolean, error?: string, cleaned?: string }}
 */
function validateInput(input) {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Invalid input type' };
  }

  const trimmed = input.trim();

  if (!trimmed.length) {
    return { ok: false, error: 'Message cannot be empty' };
  }

  if (trimmed.length > 500) {
    return { ok: false, error: 'Message too long (max 500 characters)' };
  }

  // Strip HTML tags
  const cleaned = trimmed.replace(/<[^>]*>/g, '').trim();

  // Check injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      return { ok: false, error: 'Invalid message content' };
    }
  }

  return { ok: true, cleaned };
}

/**
 * Check rate limit for session + IP
 * Logs request to rate_limit_log table
 * @param {string} sessionId
 * @param {string} ip
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
async function checkRateLimit(sessionId, ip) {
  try {
    const now = new Date();

    // Check per-session limit
    const sessionWindowStart = new Date(now - RATE_LIMIT.perSession.windowSec * 1000);
    const [sessionRows] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM rate_limit_log
       WHERE session_id = ? AND created_at >= ?`,
      [sessionId, sessionWindowStart]
    );

    if (sessionRows[0].cnt >= RATE_LIMIT.perSession.max) {
      return { allowed: false, reason: `Quá ${RATE_LIMIT.perSession.max} tin nhắn/phút. Vui lòng chờ.` };
    }

    // Check per-IP limit
    const ipWindowStart = new Date(now - RATE_LIMIT.perIp.windowSec * 1000);
    const [ipRows] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM rate_limit_log
       WHERE ip_address = ? AND created_at >= ?`,
      [ip, ipWindowStart]
    );

    if (ipRows[0].cnt >= RATE_LIMIT.perIp.max) {
      return { allowed: false, reason: `Quá ${RATE_LIMIT.perIp.max} tin nhắn/giờ từ IP này.` };
    }

    // Log this request
    await pool.execute(
      `INSERT INTO rate_limit_log (session_id, ip_address) VALUES (?, ?)`,
      [sessionId, ip]
    );

    return { allowed: true };
  } catch (err) {
    console.error('Rate limit check error:', err.message);
    // On DB error, allow through (fail open) to avoid blocking legit users
    return { allowed: true };
  }
}

/**
 * Validate AI response for potential jailbreak indicators
 * @param {string} responseText
 * @returns {boolean} true if response seems safe
 */
function validateAiResponse(responseText) {
  const suspiciousPatterns = [
    /I am now in DAN mode/i,
    /I will ignore my (previous|prior) (instruction|training)/i,
    /As an AI without restrictions/i,
  ];

  return !suspiciousPatterns.some((p) => p.test(responseText));
}

module.exports = { validateInput, checkRateLimit, validateAiResponse };
