-- FnB Chatbot: Add chatbot tables to existing meowtea_schema
-- Run: mysql -u root -p meowtea_schema < database-schema.sql
--
-- NOTE: Menu data comes from existing tables:
--   SanPham (MaSP, TenSP, Gia, MoTa, HinhAnh, TrangThai, MaCategory)
--   Category (MaCategory, TenCategory, TrangThai)

USE meowtea_schema;

-- Chat sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          VARCHAR(100) PRIMARY KEY,
  ip_address  VARCHAR(45),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Chat messages (conversation history)
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  session_id VARCHAR(100),
  role       ENUM('user', 'assistant'),
  content    TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session (session_id),
  INDEX idx_created (created_at)
);

-- Orders placed via chatbot (references SanPham.MaSP)
CREATE TABLE IF NOT EXISTS chatbot_orders (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  session_id VARCHAR(100),
  items      JSON,           -- [{"maSP":1,"tenSP":"Trà sữa","soLuong":2,"gia":45000}]
  total      DECIMAL(10,2),
  status     ENUM('pending','confirmed','cancelled') DEFAULT 'pending',
  notes      TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Rate limiting log
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  session_id VARCHAR(100),
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_session_time (session_id, created_at),
  INDEX idx_ip_time (ip_address, created_at)
);
