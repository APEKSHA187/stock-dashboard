/*// server.js — SQLite backend that broadcasts prices & history to ALL connected sockets
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const { nanoid } = require('nanoid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_change_me';

// =========================
//   SQLite DB initialization
// =========================
const DB_FILE = path.join(__dirname, 'database.sqlite');
const db = new Database(DB_FILE);

// Create tables if not exist (idempotent)
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  passwordHash TEXT
);

CREATE TABLE IF NOT EXISTS portfolios (
  email TEXT PRIMARY KEY,
  cash REAL DEFAULT 100000
);

CREATE TABLE IF NOT EXISTS holdings (
  email TEXT,
  ticker TEXT,
  qty INTEGER,
  PRIMARY KEY (email, ticker)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  ticker TEXT,
  qty INTEGER,
  type TEXT,
  price REAL,
  total REAL,
  ts INTEGER
);
`);

// add optional columns if missing
function columnExists(table, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === columnName);
}
function addColumnIfMissing(table, columnDef) {
  const colName = columnDef.split(/\s+/)[0];
  if (!columnExists(table, colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    console.log(`Migration: added column ${colName} to ${table}`);
  }
}
try {
  addColumnIfMissing('portfolios', 'realized REAL DEFAULT 0');
  addColumnIfMissing('holdings', 'avg_cost REAL DEFAULT 0');
} catch (err) {
  console.warn('Migration error (non-fatal):', err.message);
}

// =========================
//   Stock simulation & history (in-memory)
// =========================
const SUPPORTED_TICKERS = ['GOOG','TSLA','AMZN','META','NVDA'];
const prices = {};
const priceHistory = {};
const HISTORY_LEN = 60;

SUPPORTED_TICKERS.forEach(t => {
  prices[t] = +(100 + Math.random() * 400).toFixed(2);
  priceHistory[t] = [prices[t]];
});

// Price simulator: update every second, then broadcast to ALL connected sockets
setInterval(() => {
  SUPPORTED_TICKERS.forEach(t => {
    const change = (Math.random() - 0.5) * 0.02; // +/- ~1%
    prices[t] = +(prices[t] * (1 + change)).toFixed(2);

    priceHistory[t].push(prices[t]);
    if (priceHistory[t].length > HISTORY_LEN) priceHistory[t].shift();
  });

  // Broadcast full price map and full history map to all connected clients
  try {
    io.emit('stockUpdate', prices);
    io.emit('historyUpdate', priceHistory);
  } catch (err) {
    console.warn('Broadcast error', err);
  }
}, 1000);

// =========================
//   Helpers (JWT/auth)
// =========================
function generateToken(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: '12h' });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Invalid Authorization format' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// =========================
//   REST: public info
// =========================
app.get('/supported', (req, res) => {
  res.json({ supported: SUPPORTED_TICKERS, prices });
});

// =========================
//   AUTH: register / login
// =========================
app.post('/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (exists) return res.status(400).json({ error: 'Email already registered' });

  const id = nanoid();
  const hash = bcrypt.hashSync(password, 10);

  const insertUser = db.prepare('INSERT INTO users (id, email, passwordHash) VALUES (?, ?, ?)');
  const insertPortfolio = db.prepare('INSERT OR REPLACE INTO portfolios (email, cash, realized) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    insertUser.run(id, email, hash);
    insertPortfolio.run(email, 100000, 0);
  });
  tx();

  const token = generateToken(email);
  res.json({ token, email, supported: SUPPORTED_TICKERS });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });

  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

  const token = generateToken(email);
  res.json({ token, email, supported: SUPPORTED_TICKERS });
});

// =========================
//   PROFILE: /me (with P/L)
// =========================
app.get('/me', (req, res) => {
  return authMiddleware(req, res, () => {
    const email = req.user.email;
    const portRow = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email) || { cash: 0, realized: 0 };
    const holdingsRows = db.prepare('SELECT ticker, qty, avg_cost FROM holdings WHERE email = ?').all(email);

    let unrealizedTotal = 0;
    const holdings = holdingsRows.map(h => {
      const curPrice = prices[h.ticker] || 0;
      const unreal = +(((curPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
      unrealizedTotal += unreal;
      return {
        ticker: h.ticker,
        qty: h.qty,
        avg_cost: +(h.avg_cost || 0).toFixed(2),
        current_price: curPrice,
        unrealized: unreal
      };
    });

    res.json({
      email,
      portfolio: {
        cash: +(portRow.cash || 0).toFixed(2),
        realized: +(portRow.realized || 0).toFixed(2),
        holdings,
        unrealized: +unrealizedTotal.toFixed(2)
      },
      supported: SUPPORTED_TICKERS
    });
  });
});

// =========================
//   DEPOSIT endpoint
// =========================
app.post('/deposit', (req, res) => {
  return authMiddleware(req, res, () => {
    const email = req.user.email;
    const amount = Number(req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const portRow = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email);
    if (!portRow) return res.status(400).json({ error: 'Portfolio not found' });

    const newCash = +(portRow.cash + amount).toFixed(2);
    db.prepare('UPDATE portfolios SET cash = ? WHERE email = ?').run(newCash, email);

    const portResp = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email);
    const holdingsRows = db.prepare('SELECT ticker, qty, avg_cost FROM holdings WHERE email = ?').all(email);

    let unrealizedTotal = 0;
    const holdings = holdingsRows.map(h => {
      const curPrice = prices[h.ticker] || 0;
      const unreal = +(((curPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
      unrealizedTotal += unreal;
      return {
        ticker: h.ticker,
        qty: h.qty,
        avg_cost: +(h.avg_cost || 0).toFixed(2),
        current_price: curPrice,
        unrealized: unreal
      };
    });

    res.json({
      success: true,
      portfolio: {
        cash: +(portResp.cash).toFixed(2),
        realized: +(portResp.realized || 0).toFixed(2),
        holdings,
        unrealized: +unrealizedTotal.toFixed(2)
      }
    });
  });
});

// =========================
//   TRADE endpoint (buy/sell) — updates avg_cost & realized
// =========================
app.post('/trade', (req, res) => {
  return authMiddleware(req, res, () => {
    const { type, ticker, qty } = req.body;
    const email = req.user.email;

    if (!SUPPORTED_TICKERS.includes(ticker)) return res.status(400).json({ error: 'Invalid ticker' });
    const q = Number(qty);
    if (!Number.isInteger(q) || q <= 0) return res.status(400).json({ error: 'Quantity must be positive integer' });

    const price = prices[ticker];
    const total = +(price * q).toFixed(2);

    const portRow = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email);
    if (!portRow) return res.status(400).json({ error: 'Portfolio not found' });

    let cash = portRow.cash;
    let realized = portRow.realized || 0;

    const hold = db.prepare('SELECT qty, avg_cost FROM holdings WHERE email = ? AND ticker = ?').get(email, ticker);
    const ownedQty = hold ? hold.qty : 0;
    const oldAvg = hold ? (hold.avg_cost || 0) : 0;

    const insertOrReplaceHolding = db.prepare('INSERT OR REPLACE INTO holdings (email, ticker, qty, avg_cost) VALUES (?, ?, ?, ?)');

    if (type === 'buy') {
      if (cash < total) return res.status(400).json({ error: 'Insufficient cash' });

      const newQty = ownedQty + q;
      const newAvg = ((oldAvg * ownedQty) + (price * q)) / newQty;

      const tx = db.transaction(() => {
        insertOrReplaceHolding.run(email, ticker, newQty, newAvg);
        db.prepare('UPDATE portfolios SET cash = ? WHERE email = ?').run(+(cash - total).toFixed(2), email);
        db.prepare('INSERT INTO trades (email, ticker, qty, type, price, total, ts) VALUES (?, ?, ?, ?, ?, ?, ?)').run(email, ticker, q, 'buy', price, total, Date.now());
      });
      tx();

    } else { // sell
      if (ownedQty < q) return res.status(400).json({ error: 'Insufficient holdings' });

      const pnl = +(((price - oldAvg) * q).toFixed(2));
      realized = +( (realized || 0) + pnl ).toFixed(2);
      const newQty = ownedQty - q;

      const tx = db.transaction(() => {
        if (newQty === 0) {
          db.prepare('DELETE FROM holdings WHERE email = ? AND ticker = ?').run(email, ticker);
        } else {
          insertOrReplaceHolding.run(email, ticker, newQty, oldAvg);
        }
        db.prepare('UPDATE portfolios SET cash = ?, realized = ? WHERE email = ?').run(+(cash + total).toFixed(2), realized, email);
        db.prepare('INSERT INTO trades (email, ticker, qty, type, price, total, ts) VALUES (?, ?, ?, ?, ?, ?, ?)').run(email, ticker, q, 'sell', price, total, Date.now());
      });
      tx();
    }

    const portResp = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email);
    const holdingsRows = db.prepare('SELECT ticker, qty, avg_cost FROM holdings WHERE email = ?').all(email);

    let unrealizedTotal = 0;
    const holdingsRes = holdingsRows.map(h => {
      const curPrice = prices[h.ticker] || 0;
      const unreal = +(((curPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
      unrealizedTotal += unreal;
      return {
        ticker: h.ticker,
        qty: h.qty,
        avg_cost: +(h.avg_cost || 0).toFixed(2),
        current_price: curPrice,
        unrealized: unreal
      };
    });

    for (const socket of io.sockets.sockets.values()) {
      if (socket.user && socket.user.email === email) {
        socket.emit('portfolioUpdate', {
          cash: +(portResp.cash || 0).toFixed(2),
          realized: +(portResp.realized || 0).toFixed(2),
          holdings: holdingsRes,
          unrealized: +unrealizedTotal.toFixed(2)
        });
        socket.emit('tradeExecuted', { type, ticker, qty: q, price, total });
      }
    }

    return res.json({
      success: true,
      trade: { type, ticker, qty: q, price, total },
      portfolio: {
        cash: +(portResp.cash || 0).toFixed(2),
        realized: +(portResp.realized || 0).toFixed(2),
        holdings: holdingsRes,
        unrealized: +unrealizedTotal.toFixed(2)
      }
    });
  });
});

// =========================
//   SOCKET.IO handlers — auth only, no subscription required
// =========================
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error: missing token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    return next();
  } catch (err) {
    return next(new Error('Authentication error: invalid token'));
  }
});

io.on('connection', socket => {
  // send initial prices + history immediately to this socket
  socket.emit('stockUpdate', prices);
  socket.emit('historyUpdate', priceHistory);

  // send initial portfolio if exists
  (function sendInitialPortfolio() {
    const email = socket.user.email;
    const portRow = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email) || { cash: 0, realized: 0 };
    const holdingsRows = db.prepare('SELECT ticker, qty, avg_cost FROM holdings WHERE email = ?').all(email);

    let unreal = 0;
    const holdingsRes = holdingsRows.map(h => {
      const curPrice = prices[h.ticker] || 0;
      const unrealized = +(((curPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
      unreal += unrealized;
      return {
        ticker: h.ticker,
        qty: h.qty,
        avg_cost: +(h.avg_cost || 0).toFixed(2),
        current_price: curPrice,
        unrealized: unrealized
      };
    });

    socket.emit('portfolioUpdate', {
      cash: +(portRow.cash || 0).toFixed(2),
      realized: +(portRow.realized || 0).toFixed(2),
      holdings: holdingsRes,
      unrealized: +unreal.toFixed(2)
    });
  })();

  socket.on('getPrices', () => {
    socket.emit('prices', prices);
  });

  socket.on('getHistory', (ticker) => {
    if (!SUPPORTED_TICKERS.includes(ticker)) return socket.emit('history', { ticker, history: [] });
    socket.emit('history', { ticker, history: priceHistory[ticker] || [] });
  });

  socket.on('disconnect', () => {
    // nothing required
  });
});

// =========================
//   Start server
// =========================
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`SQLite DB file: ${DB_FILE}`);
});
*/
// server.js — SQLite backend that broadcasts prices & history to ALL connected sockets
const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const { nanoid } = require('nanoid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key_change_me';

// =========================
//   SQLite DB initialization
// =========================
const DB_FILE = path.join(__dirname, 'database.sqlite');
const db = new Database(DB_FILE);

// Create tables if not exist (idempotent)
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  passwordHash TEXT
);

CREATE TABLE IF NOT EXISTS portfolios (
  email TEXT PRIMARY KEY,
  cash REAL DEFAULT 100000
);

CREATE TABLE IF NOT EXISTS holdings (
  email TEXT,
  ticker TEXT,
  qty INTEGER,
  PRIMARY KEY (email, ticker)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  ticker TEXT,
  qty INTEGER,
  type TEXT,
  price REAL,
  total REAL,
  ts INTEGER
);
`);

// add optional columns if missing (migration)
function columnExists(table, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === columnName);
}
function addColumnIfMissing(table, columnDef) {
  const colName = columnDef.split(/\s+/)[0];
  if (!columnExists(table, colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    console.log(`Migration: added column ${colName} to ${table}`);
  }
}
try {
  addColumnIfMissing('portfolios', 'realized REAL DEFAULT 0');
  addColumnIfMissing('holdings', 'avg_cost REAL DEFAULT 0');
} catch (err) {
  console.warn('Migration error (non-fatal):', err.message);
}

// =========================
//   Stock simulation & history (in-memory)
// =========================
const SUPPORTED_TICKERS = ['GOOG','TSLA','AMZN','META','NVDA'];
const prices = {};
const priceHistory = {};
const HISTORY_LEN = 120; // keep last 120 points

SUPPORTED_TICKERS.forEach(t => {
  prices[t] = +(100 + Math.random() * 400).toFixed(2);
  priceHistory[t] = [prices[t]];
});

// Price simulator: update every second, then broadcast to ALL connected sockets
setInterval(() => {
  SUPPORTED_TICKERS.forEach(t => {
    const change = (Math.random() - 0.5) * 0.02; // +/- ~1%
    prices[t] = +(prices[t] * (1 + change)).toFixed(2);

    priceHistory[t].push(prices[t]);
    if (priceHistory[t].length > HISTORY_LEN) priceHistory[t].shift();
  });

  // Broadcast full price map and full history map to all connected clients
  try {
    io.emit('stockUpdate', prices);
    io.emit('historyUpdate', priceHistory);
  } catch (err) {
    console.warn('Broadcast error', err);
  }
}, 1000);

// =========================
//   Helpers (JWT/auth)
// =========================
function generateToken(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: '12h' });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Invalid Authorization format' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// =========================
//   REST: public info
// =========================
app.get('/supported', (req, res) => {
  res.json({ supported: SUPPORTED_TICKERS, prices });
});

// =========================
//   AUTH: register / login
// =========================
app.post('/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
  if (exists) return res.status(400).json({ error: 'Email already registered' });

  const id = nanoid();
  const hash = bcrypt.hashSync(password, 10);

  const insertUser = db.prepare('INSERT INTO users (id, email, passwordHash) VALUES (?, ?, ?)');
  const insertPortfolio = db.prepare('INSERT OR REPLACE INTO portfolios (email, cash, realized) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    insertUser.run(id, email, hash);
    insertPortfolio.run(email, 100000, 0);
  });
  tx();

  const token = generateToken(email);
  res.json({ token, email, supported: SUPPORTED_TICKERS });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });

  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

  const token = generateToken(email);
  res.json({ token, email, supported: SUPPORTED_TICKERS });
});

// =========================
//   PROFILE: /me (with P/L)
// =========================
app.get('/me', (req, res) => {
  return authMiddleware(req, res, () => {
    const email = req.user.email;
    const portRow = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email) || { cash: 0, realized: 0 };
    const holdingsRows = db.prepare('SELECT ticker, qty, avg_cost FROM holdings WHERE email = ?').all(email);

    let unrealizedTotal = 0;
    const holdings = holdingsRows.map(h => {
      const curPrice = prices[h.ticker] || 0;
      const unreal = +(((curPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
      unrealizedTotal += unreal;
      return {
        ticker: h.ticker,
        qty: h.qty,
        avg_cost: +(h.avg_cost || 0).toFixed(2),
        current_price: curPrice,
        unrealized: unreal
      };
    });

    res.json({
      email,
      portfolio: {
        cash: +(portRow.cash || 0).toFixed(2),
        realized: +(portRow.realized || 0).toFixed(2),
        holdings,
        unrealized: +unrealizedTotal.toFixed(2)
      },
      supported: SUPPORTED_TICKERS
    });
  });
});
// =========================
//   TRANSACTION HISTORY
// =========================
app.get('/trades', (req, res) => {
  return authMiddleware(req, res, () => {
    const email = req.user.email;

    const rows = db.prepare(`
      SELECT ticker, qty, type, price, total, ts
      FROM trades
      WHERE email = ?
      ORDER BY ts DESC
      LIMIT 50
    `).all(email);

    res.json({ trades: rows });
  });
});

// =========================
//   DEPOSIT endpoint
// =========================
app.post('/deposit', (req, res) => {
  return authMiddleware(req, res, () => {
    const email = req.user.email;
    const amount = Number(req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const portRow = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email);
    if (!portRow) return res.status(400).json({ error: 'Portfolio not found' });

    const newCash = +(portRow.cash + amount).toFixed(2);
    db.prepare('UPDATE portfolios SET cash = ? WHERE email = ?').run(newCash, email);

    const portResp = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email);
    const holdingsRows = db.prepare('SELECT ticker, qty, avg_cost FROM holdings WHERE email = ?').all(email);

    let unrealizedTotal = 0;
    const holdings = holdingsRows.map(h => {
      const curPrice = prices[h.ticker] || 0;
      const unreal = +(((curPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
      unrealizedTotal += unreal;
      return {
        ticker: h.ticker,
        qty: h.qty,
        avg_cost: +(h.avg_cost || 0).toFixed(2),
        current_price: curPrice,
        unrealized: unreal
      };
    });

    res.json({
      success: true,
      portfolio: {
        cash: +(portResp.cash).toFixed(2),
        realized: +(portResp.realized || 0).toFixed(2),
        holdings,
        unrealized: +unrealizedTotal.toFixed(2)
      }
    });
  });
});

// =========================
//   TRADE endpoint (buy/sell) — updates avg_cost & realized
// =========================
app.post('/trade', (req, res) => {
  return authMiddleware(req, res, () => {
    const { type, ticker, qty } = req.body;
    const email = req.user.email;

    if (!SUPPORTED_TICKERS.includes(ticker)) return res.status(400).json({ error: 'Invalid ticker' });
    const q = Number(qty);
    if (!Number.isInteger(q) || q <= 0) return res.status(400).json({ error: 'Quantity must be positive integer' });

    const price = prices[ticker];
    const total = +(price * q).toFixed(2);

    const portRow = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email);
    if (!portRow) return res.status(400).json({ error: 'Portfolio not found' });

    let cash = portRow.cash;
    let realized = portRow.realized || 0;

    const hold = db.prepare('SELECT qty, avg_cost FROM holdings WHERE email = ? AND ticker = ?').get(email, ticker);
    const ownedQty = hold ? hold.qty : 0;
    const oldAvg = hold ? (hold.avg_cost || 0) : 0;

    const insertOrReplaceHolding = db.prepare('INSERT OR REPLACE INTO holdings (email, ticker, qty, avg_cost) VALUES (?, ?, ?, ?)');

    if (type === 'buy') {
      if (cash < total) return res.status(400).json({ error: 'Insufficient cash' });

      const newQty = ownedQty + q;
      const newAvg = ((oldAvg * ownedQty) + (price * q)) / newQty;

      const tx = db.transaction(() => {
        insertOrReplaceHolding.run(email, ticker, newQty, newAvg);
        db.prepare('UPDATE portfolios SET cash = ? WHERE email = ?').run(+(cash - total).toFixed(2), email);
        db.prepare('INSERT INTO trades (email, ticker, qty, type, price, total, ts) VALUES (?, ?, ?, ?, ?, ?, ?)').run(email, ticker, q, 'buy', price, total, Date.now());
      });
      tx();

    } else { // sell
      if (ownedQty < q) return res.status(400).json({ error: 'Insufficient holdings' });

      const pnl = +(((price - oldAvg) * q).toFixed(2));
      realized = +( (realized || 0) + pnl ).toFixed(2);
      const newQty = ownedQty - q;

      const tx = db.transaction(() => {
        if (newQty === 0) {
          db.prepare('DELETE FROM holdings WHERE email = ? AND ticker = ?').run(email, ticker);
        } else {
          insertOrReplaceHolding.run(email, ticker, newQty, oldAvg);
        }
        db.prepare('UPDATE portfolios SET cash = ?, realized = ? WHERE email = ?').run(+(cash + total).toFixed(2), realized, email);
        db.prepare('INSERT INTO trades (email, ticker, qty, type, price, total, ts) VALUES (?, ?, ?, ?, ?, ?, ?)').run(email, ticker, q, 'sell', price, total, Date.now());
      });
      tx();
    }

    const portResp = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email);
    const holdingsRows = db.prepare('SELECT ticker, qty, avg_cost FROM holdings WHERE email = ?').all(email);

    let unrealizedTotal = 0;
    const holdingsRes = holdingsRows.map(h => {
      const curPrice = prices[h.ticker] || 0;
      const unreal = +(((curPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
      unrealizedTotal += unreal;
      return {
        ticker: h.ticker,
        qty: h.qty,
        avg_cost: +(h.avg_cost || 0).toFixed(2),
        current_price: curPrice,
        unrealized: unreal
      };
    });

    for (const socket of io.sockets.sockets.values()) {
      if (socket.user && socket.user.email === email) {
        socket.emit('portfolioUpdate', {
          cash: +(portResp.cash || 0).toFixed(2),
          realized: +(portResp.realized || 0).toFixed(2),
          holdings: holdingsRes,
          unrealized: +unrealizedTotal.toFixed(2)
        });
        socket.emit('tradeExecuted', { type, ticker, qty: q, price, total });
      }
    }

    return res.json({
      success: true,
      trade: { type, ticker, qty: q, price, total },
      portfolio: {
        cash: +(portResp.cash || 0).toFixed(2),
        realized: +(portResp.realized || 0).toFixed(2),
        holdings: holdingsRes,
        unrealized: +unrealizedTotal.toFixed(2)
      }
    });
  });
});

// =========================
//   SOCKET.IO handlers — auth only
// =========================
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error: missing token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    return next();
  } catch (err) {
    return next(new Error('Authentication error: invalid token'));
  }
});

io.on('connection', socket => {
  // send initial prices + history immediately to this socket
  socket.emit('stockUpdate', prices);
  socket.emit('historyUpdate', priceHistory);

  // send initial portfolio if exists
  (function sendInitialPortfolio() {
    const email = socket.user.email;
    const portRow = db.prepare('SELECT cash, realized FROM portfolios WHERE email = ?').get(email) || { cash: 0, realized: 0 };
    const holdingsRows = db.prepare('SELECT ticker, qty, avg_cost FROM holdings WHERE email = ?').all(email);

    let unreal = 0;
    const holdingsRes = holdingsRows.map(h => {
      const curPrice = prices[h.ticker] || 0;
      const unrealized = +(((curPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
      unreal += unrealized;
      return {
        ticker: h.ticker,
        qty: h.qty,
        avg_cost: +(h.avg_cost || 0).toFixed(2),
        current_price: curPrice,
        unrealized: unrealized
      };
    });

    socket.emit('portfolioUpdate', {
      cash: +(portRow.cash || 0).toFixed(2),
      realized: +(portRow.realized || 0).toFixed(2),
      holdings: holdingsRes,
      unrealized: +unreal.toFixed(2)
    });
  })();

  socket.on('getPrices', () => {
    socket.emit('prices', prices);
  });

  socket.on('getHistory', (ticker) => {
    if (!SUPPORTED_TICKERS.includes(ticker)) return socket.emit('history', { ticker, history: [] });
    socket.emit('history', { ticker, history: priceHistory[ticker] || [] });
  });

  socket.on('disconnect', () => {
    // nothing required here
  });
});

// =========================
//   Serve React frontend (SINGLE LINK)
// =========================
app.use(express.static(path.join(__dirname, 'build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// =========================
//   Start server
// =========================
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`SQLite DB file: ${DB_FILE}`);
});
