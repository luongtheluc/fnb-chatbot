/**
 * Smart menu context loader
 * Queries MySQL based on keywords in user message to inject relevant menu items
 */

const { pool } = require('./db');

// Max menu items to inject into context (avoid token bloat)
const MAX_MENU_ITEMS = 10;

/**
 * Extract keywords from user message for SQL search
 * @param {string} message
 * @returns {string[]}
 */
function extractKeywords(message) {
  const normalized = message.toLowerCase().trim();

  // Common FnB stop words to ignore
  const stopWords = new Set([
    'có', 'không', 'tôi', 'muốn', 'cho', 'xem', 'danh', 'sách',
    'menu', 'gì', 'nào', 'ở', 'đây', 'bạn', 'mình', 'được', 'ạ',
    'nhé', 'thôi', 'cái', 'này', 'kia', 'đó', 'và', 'hay', 'hoặc',
    'the', 'a', 'an', 'is', 'are', 'do', 'does', 'can', 'you', 'have',
  ]);

  // Split on whitespace + punctuation, filter stop words, min length 2
  return normalized
    .split(/[\s,.\-?!]+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w));
}

/**
 * Load relevant menu items from MySQL based on user message
 * @param {string} userMessage
 * @returns {Promise<Array>} menu items
 */
async function getMenuContext(userMessage) {
  try {
    const keywords = extractKeywords(userMessage);

    // Base query: join SanPham with Category
    // Columns: GiaCoBan (base price), GiaNiemYet (listed price) — no description column
    const BASE_SELECT = `
      SELECT sp.MaSP AS id, sp.TenSP AS name,
             sp.GiaCoBan AS price, sp.GiaNiemYet AS listed_price,
             sp.HinhAnh AS image, c.TenCategory AS category
      FROM SanPham sp
      LEFT JOIN Category c ON sp.MaCategory = c.MaCategory
      WHERE sp.TrangThai = 1`;

    // Use pool.query (not execute) — avoids prepared-statement issues with
    // dynamic LIMIT + JOIN queries on MySQL 5.7/MariaDB
    const LIMIT = parseInt(MAX_MENU_ITEMS, 10);
    let rows;

    if (keywords.length === 0) {
      const [result] = await pool.query(
        `${BASE_SELECT} ORDER BY c.TenCategory, sp.TenSP LIMIT ${LIMIT}`
      );
      rows = result;
    } else {
      // Build parameterized LIKE conditions (pool.query supports ? params safely)
      const conditions = [];
      const params = [];

      for (const kw of keywords.slice(0, 5)) {
        conditions.push('(sp.TenSP LIKE ? OR c.TenCategory LIKE ?)');
        const like = `%${kw}%`;
        params.push(like, like);
      }

      const [result] = await pool.query(
        `${BASE_SELECT} AND (${conditions.join(' OR ')}) ORDER BY sp.TenSP LIMIT ${LIMIT}`,
        params
      );
      rows = result;

      // Fallback to full menu if no keyword match
      if (rows.length === 0) {
        const [fallback] = await pool.query(
          `${BASE_SELECT} ORDER BY c.TenCategory, sp.TenSP LIMIT ${LIMIT}`
        );
        rows = fallback;
      }
    }

    return rows;
  } catch (err) {
    console.error('getMenuContext error:', err.message);
    return [];
  }
}

/**
 * Format menu rows into compact text for system prompt injection
 * @param {Array} menuItems
 * @returns {string}
 */
function formatMenuForPrompt(menuItems) {
  if (!menuItems.length) return 'Hiện tại chưa có dữ liệu menu.';

  // Group by category
  const byCategory = {};
  for (const item of menuItems) {
    const cat = item.category || 'Khác';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  }

  const lines = [];
  for (const [cat, items] of Object.entries(byCategory)) {
    lines.push(`\n**${cat}:**`);
    for (const item of items) {
      const price = Number(item.price).toLocaleString('vi-VN');
      // Show listed price if it differs from base price (e.g. discount available)
      const listed = Number(item.listed_price);
      const priceStr = listed > Number(item.price)
        ? `${price}đ (niêm yết: ${listed.toLocaleString('vi-VN')}đ)`
        : `${price}đ`;
      lines.push(`  • ${item.name}: ${priceStr}`);
    }
  }

  return lines.join('\n');
}

module.exports = { getMenuContext, formatMenuForPrompt };
