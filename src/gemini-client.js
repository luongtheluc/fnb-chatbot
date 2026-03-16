/**
 * Gemini API wrapper — supports streaming via Server-Sent Events (SSE)
 *
 * Model priority (configurable via GEMINI_MODEL env var):
 *   gemini-2.0-flash → gemini-1.5-flash (auto-fallback on quota error)
 *
 * NOTE: Use an API key from https://aistudio.google.com/apikey
 *   NOT from Google Cloud Console (different quota pool).
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Model fallback chain: primary → fallback if quota exhausted
// gemini-flash-latest = smart alias, always points to latest Flash with available quota
const MODEL_CHAIN = [
  process.env.GEMINI_MODEL || 'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];
const MAX_RETRIES = 2;

/**
 * Extract retry delay (seconds) from Gemini 429 error body
 * @param {string} errText
 * @returns {number} seconds to wait (default 5)
 */
function parseRetryDelay(errText) {
  try {
    const json = JSON.parse(errText);
    const retryInfo = json?.error?.details?.find(
      (d) => d['@type']?.includes('RetryInfo')
    );
    if (retryInfo?.retryDelay) {
      return parseInt(retryInfo.retryDelay) || 5;
    }
  } catch { /* ignore */ }
  return 5;
}

/**
 * Build a user message part that optionally includes an image
 * @param {string} text - User text message
 * @param {string|null} imageBase64 - Base64 encoded image (without data: prefix)
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @returns {Object} Gemini content object
 */
function buildUserMessage(text, imageBase64 = null, mimeType = 'image/jpeg') {
  const parts = [];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  }
  if (text) parts.push({ text });
  return { role: 'user', parts };
}

/**
 * Stream chat response from Gemini API with model fallback + retry on 429
 * @param {Array} messages - Gemini contents array (use buildUserMessage for new messages)
 * @param {string} systemPrompt - System instruction
 * @param {Function} onChunk - Callback for each text chunk: (text) => void
 * @param {Function} onDone - Callback when stream ends
 * @param {Function} onError - Callback on error: (err) => void
 */
async function streamChat(messages, systemPrompt, onChunk, onDone, onError) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return onError(new Error('GEMINI_API_KEY not set'));

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: messages,
    generationConfig: {
      temperature: 1.0,
      topP: 1.0,
      topK: 20,
      maxOutputTokens: 2048,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  // Try each model in chain, retry on 429
  for (let modelIdx = 0; modelIdx < MODEL_CHAIN.length; modelIdx++) {
    const model = MODEL_CHAIN[modelIdx];
    const url = `${GEMINI_API_BASE}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        return onError(new Error('Network error: ' + err.message));
      }

      if (response.status === 429) {
        const errText = await response.text();
        const delaySec = parseRetryDelay(errText);

        // If quota is 0 (not rate-limited, but no access) → try next model
        if (errText.includes('"limit": 0') || errText.includes('"limit":0')) {
          console.warn(`[Gemini] No quota for ${model}, trying next model...`);
          break; // exit retry loop, go to next model
        }

        if (attempt < MAX_RETRIES) {
          console.warn(`[Gemini] 429 on ${model}, retrying in ${delaySec}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, delaySec * 1000));
          continue;
        } else {
          // Exhausted retries → try next model
          console.warn(`[Gemini] Exhausted retries for ${model}, trying next model...`);
          break;
        }
      }

      if (!response.ok) {
        const errText = await response.text();
        return onError(new Error(`Gemini API error ${response.status}: ${errText}`));
      }

      // ── Success: parse SSE stream ──
      if (modelIdx > 0 || attempt > 0) {
        console.log(`[Gemini] Using model: ${model} (attempt ${attempt + 1})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const json = JSON.parse(data);
              const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) onChunk(text);

              const finishReason = json?.candidates?.[0]?.finishReason;
              if (finishReason && finishReason !== 'STOP') {
                console.warn('[Gemini] finish reason:', finishReason);
              }
            } catch { /* skip malformed chunk */ }
          }
        }
        return onDone();
      } catch (err) {
        return onError(err);
      }
    }
  }

  // All models exhausted
  return onError(new Error('Gemini service unavailable. Please try again later.'));
}

module.exports = { streamChat, buildUserMessage };
