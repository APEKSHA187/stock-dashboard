/*
// Dashboard.js — now recalculates unrealized P/L on every price update
import React, { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const API = 'http://localhost:4000';
const getToken = () => localStorage.getItem('token');
const getEmail = () => localStorage.getItem('email');

function normalizePortfolio(portfolio) {
  if (!portfolio) return { cash: 0, realized: 0, holdings: [], unrealized: 0 };

  let holdings = [];
  if (Array.isArray(portfolio.holdings)) {
    holdings = portfolio.holdings.map(h => ({
      ticker: h.ticker,
      qty: Number(h.qty || 0),
      avg_cost: Number(h.avg_cost || 0),
      current_price: Number(h.current_price || 0),
      unrealized: Number(h.unrealized || 0)
    }));
  } else if (portfolio.holdings && typeof portfolio.holdings === 'object') {
    holdings = Object.entries(portfolio.holdings).map(([ticker, qty]) => ({
      ticker,
      qty: Number(qty || 0),
      avg_cost: 0,
      current_price: 0,
      unrealized: 0
    }));
  }

  const cash = Number(portfolio.cash ?? 0);
  const realized = Number(portfolio.realized ?? 0);
  const unrealized = Number(portfolio.unrealized ?? holdings.reduce((s, h) => s + (Number(h.unrealized) || 0), 0));

  return { cash, realized, holdings, unrealized };
}

// Recalculate holdings' current_price and unrealized P/L using the provided prices map
function recalcPortfolioWithPrices(portfolio, prices) {
  if (!portfolio) return portfolio;
  const holdings = (portfolio.holdings || []).map(h => {
    const currentPrice = prices[h.ticker] ?? (h.current_price ?? 0);
    const unrealized = +(((currentPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
    return {
      ...h,
      current_price: Number(currentPrice),
      unrealized: unrealized
    };
  });
  const unrealizedTotal = holdings.reduce((s, h) => s + (Number(h.unrealized) || 0), 0);
  return {
    ...portfolio,
    holdings,
    unrealized: +unrealizedTotal.toFixed(2)
  };
}

export default function Dashboard() {
  const email = getEmail();
  const token = getToken();

  const [connected, setConnected] = useState(false);
  const [supported, setSupported] = useState(['GOOG','TSLA','AMZN','META','NVDA']);
  const [prices, setPrices] = useState({});
  const [portfolio, setPortfolio] = useState({ cash:0, realized:0, holdings: [], unrealized:0 });
  const [selectedTicker, setSelectedTicker] = useState(supported[0]);
  const [history, setHistory] = useState([]);
  const [qty, setQty] = useState(1);
  const [tradeMsg, setTradeMsg] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [depositMsg, setDepositMsg] = useState('');
  const socketRef = useRef(null);

  useEffect(() => {
    if (!token) { window.location.href = '/login'; return; }

    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('getPrices');
      if (selectedTicker) socket.emit('getHistory', selectedTicker);
    });

    socket.on('disconnect', () => setConnected(false));

    // When a partial stock update arrives, merge prices and recalc portfolio
    socket.on('stockUpdate', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      setPrices(prevPrices => {
        const updated = { ...prevPrices, ...payload };
        // Recalculate portfolio using updated prices
        setPortfolio(prevPort => recalcPortfolioWithPrices(prevPort, updated));
        return updated;
      });
    });

    // When a full prices snapshot arrives, replace and recalc
    socket.on('prices', (all) => {
      if (all && typeof all === 'object') {
        setPrices(all);
        setPortfolio(prevPort => recalcPortfolioWithPrices(prevPort, all));
      }
    });

    // history one-time response
    socket.on('history', ({ ticker, history }) => {
      if (ticker === selectedTicker) setHistory(Array.isArray(history) ? history : []);
    });

    // live history updates for chart
    socket.on('historyUpdate', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      // payload is an object keyed by ticker -> array
      if (selectedTicker && payload[selectedTicker]) {
        setHistory(Array.isArray(payload[selectedTicker]) ? payload[selectedTicker] : []);
      }
      // (no P/L change needed here - P/L uses prices map)
    });

    socket.on('portfolioUpdate', (p) => {
      // server sends portfolio snapshot; normalize then recalc using live prices
      const norm = normalizePortfolio(p);
      const withCurrent = recalcPortfolioWithPrices(norm, prices);
      setPortfolio(withCurrent);
    });

    socket.on('tradeExecuted', (trade) => {
      setTradeMsg(`Trade executed: ${trade.type} ${trade.qty} ${trade.ticker} @ ${trade.price}`);
      // server will also send portfolioUpdate, but even if it doesn't, we've recalced on price updates
    });

    socket.on('connect_error', (err) => console.error('socket connect_error', err && err.message ? err.message : err));

    (async function fetchMe() {
      try {
        const res = await fetch(`${API}/me`, { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json();
        if (res.ok) {
          if (data.supported) {
            setSupported(data.supported);
            localStorage.setItem('supported', JSON.stringify(data.supported));
            if (!selectedTicker && data.supported.length) setSelectedTicker(data.supported[0]);
          }
          const norm = normalizePortfolio(data.portfolio);
          const withCurrent = recalcPortfolioWithPrices(norm, prices);
          setPortfolio(withCurrent);
        } else {
          console.warn('/me failed', data);
        }
      } catch (err) {
        console.error('fetch /me error', err);
      }
    })();

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedTicker]);

  // request one-time history when ticker changes
  useEffect(() => {
    const socket = socketRef.current;
    if (socket && selectedTicker) socket.emit('getHistory', selectedTicker);
  }, [selectedTicker]);

  async function doTrade(type) {
    setTradeMsg('');
    const q = Number(qty);
    if (!selectedTicker || !Number.isInteger(q) || q <= 0) { setTradeMsg('Invalid quantity'); return; }
    try {
      const res = await fetch(`${API}/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ type, ticker: selectedTicker, qty: q })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Trade failed');
      // server returns portfolio; normalize and ensure current prices applied
      const norm = normalizePortfolio(data.portfolio);
      const withCurrent = recalcPortfolioWithPrices(norm, prices);
      setPortfolio(withCurrent);
      setTradeMsg(`Success: ${type} ${q} ${selectedTicker} @ ${data.trade.price}`);
    } catch (err) {
      setTradeMsg(err.message || String(err));
    }
  }

  async function depositCash() {
    setDepositMsg('');
    const amt = Number(depositAmount);
    if (!amt || amt <= 0) { setDepositMsg('Enter valid amount'); return; }
    try {
      const res = await fetch(`${API}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ amount: amt })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deposit failed');
      const norm = normalizePortfolio(data.portfolio);
      const withCurrent = recalcPortfolioWithPrices(norm, prices);
      setPortfolio(withCurrent);
      setDepositMsg('Deposit successful');
      setDepositAmount('');
    } catch (err) {
      setDepositMsg(err.message || String(err));
    }
  }

  const chartData = {
    labels: history.map((_, i) => i + 1),
    datasets: [
      { label: selectedTicker || 'Price', data: history, fill: false, tension: 0.15 }
    ]
  };

  return (
    <div className="container">
      <div className="header">
        <h2>Stock Dashboard</h2>
        <div>
          <strong>{email}</strong>
          <button className="btn small" onClick={() => { localStorage.removeItem('token'); localStorage.removeItem('email'); window.location.href = '/login'; }}>Logout</button>
        </div>
      </div>

      <div className="status">Connection: <span className={connected ? 'connected' : 'disconnected'}>{connected ? 'Connected' : 'Disconnected'}</span></div>

      <div className="cols">
        <div className="col">
          <h3>Supported Stocks</h3>
          <ul className="list">
            {supported.map(t => (
              <li key={t} className="list-item">
                <div>
                  <strong style={{marginRight:8}}>{t}</strong>
                  <span className="muted">Latest: { (prices[t] ?? 0).toFixed ? (prices[t] ?? 0).toFixed(2) : String(prices[t] ?? '—') }</span>
                </div>
                <div>
                  <button className="btn small" style={{marginLeft:8}} onClick={() => setSelectedTicker(t)}>View</button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="col">
          <h3>Chart — {selectedTicker}</h3>
          <div style={{height:260}}>
            <Line data={chartData} />
          </div>

          <h3 style={{marginTop:12}}>Trade Panel</h3>
          <div style={{display:'flex', gap:8, alignItems:'center'}}>
            <select value={selectedTicker} onChange={e => setSelectedTicker(e.target.value)}>
              {supported.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input type="number" value={qty} onChange={e => setQty(e.target.value)} style={{width:80}} />
            <button className="btn" onClick={() => doTrade('buy')}>Buy</button>
            <button className="btn" onClick={() => doTrade('sell')}>Sell</button>
          </div>
          <div className="muted" style={{marginTop:8}}>{tradeMsg}</div>

          <h3 style={{marginTop:12}}>Portfolio</h3>

          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:12}}>
            <div>
              <div>Cash: ${portfolio.cash?.toFixed(2) ?? '0.00'}</div>
              <div style={{marginTop:6}}>
                <strong>Holdings</strong>
              </div>
            </div>

            <div style={{minWidth:240}}>
              <label style={{display:'block',fontSize:13}}>Add Cash</label>
              <div style={{display:'flex', gap:8, marginTop:6}}>
                <input type="number" value={depositAmount} onChange={e => setDepositAmount(e.target.value)} placeholder="Amount" style={{padding:6, width:140}} />
                <button className="btn" onClick={depositCash}>Add Cash</button>
              </div>
              {depositMsg && <div style={{marginTop:8, color: depositMsg.includes('successful') ? 'green' : 'red'}}>{depositMsg}</div>}
            </div>
          </div>

          <table className="table" style={{marginTop:10}}>
            <thead>
              <tr><th>Ticker</th><th>Qty</th><th>Price</th><th>P/L</th></tr>
            </thead>
            <tbody>
              { (!portfolio.holdings || portfolio.holdings.length === 0) && <tr><td colSpan={4}>No holdings</td></tr> }
              { (portfolio.holdings || []).map(h => (
                <tr key={h.ticker}>
                  <td>{h.ticker}</td>
                  <td>{h.qty}</td>
                  <td>${(h.current_price || prices[h.ticker] || 0).toFixed(2)}</td>
                  <td style={{color: (h.unrealized < 0) ? '#e64a4a' : '#16a34a'}}>{(h.unrealized || 0).toFixed(2)}</td>
                </tr>
              )) }
            </tbody>
          </table>

          <div style={{marginTop:8, fontSize:13, color:'#666'}}>
            <strong>Unrealized:</strong> {portfolio.unrealized != null ? portfolio.unrealized.toFixed(2) : '0.00'} &nbsp;&nbsp;
            <strong>Realized:</strong> {portfolio.realized != null ? portfolio.realized.toFixed(2) : '0.00'}
          </div>

        </div>
      </div>

      <div className="note" style={{marginTop:16}}>Tip: Open another browser/incognito and login with another user to test asynchronous updates.</div>
    </div>
  );
}
*/
/*
// client/src/Dashboard.js
import React, { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';
import { Line, Chart as ChartComponent } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
} from 'chart.js';
import 'chartjs-adapter-date-fns'; // helpful if you later use time-based scales
import './index.css'; // ensure your CSS (dark theme + chart contrasts) is imported

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, TimeScale);

// -----------------------
// CONFIG: API and helpers
// -----------------------
const API = 'http://localhost:4000';
const getToken = () => localStorage.getItem('token');
const getEmail = () => localStorage.getItem('email');

// Normalize portfolio shape returned by server
function normalizePortfolio(portfolio) {
  if (!portfolio) return { cash: 0, realized: 0, holdings: [], unrealized: 0 };

  let holdings = [];
  if (Array.isArray(portfolio.holdings)) {
    holdings = portfolio.holdings.map(h => ({
      ticker: h.ticker,
      qty: Number(h.qty || 0),
      avg_cost: Number(h.avg_cost || 0),
      current_price: Number(h.current_price || 0),
      unrealized: Number(h.unrealized || 0)
    }));
  } else if (portfolio.holdings && typeof portfolio.holdings === 'object') {
    holdings = Object.entries(portfolio.holdings).map(([ticker, qty]) => ({
      ticker,
      qty: Number(qty || 0),
      avg_cost: 0,
      current_price: 0,
      unrealized: 0
    }));
  }

  const cash = Number(portfolio.cash ?? 0);
  const realized = Number(portfolio.realized ?? 0);
  const unrealized = Number(portfolio.unrealized ?? holdings.reduce((s, h) => s + (Number(h.unrealized) || 0), 0));

  return { cash, realized, holdings, unrealized };
}

// Recalculate holdings' current_price & unrealized P/L with live prices
function recalcPortfolioWithPrices(portfolio, prices) {
  if (!portfolio) return portfolio;
  const holdings = (portfolio.holdings || []).map(h => {
    const currentPrice = prices[h.ticker] ?? (h.current_price ?? 0);
    const unrealized = +(((currentPrice - (h.avg_cost || 0)) * h.qty).toFixed(2));
    return {
      ...h,
      current_price: Number(currentPrice),
      unrealized
    };
  });
  const unrealizedTotal = holdings.reduce((s, h) => s + (Number(h.unrealized) || 0), 0);
  return { ...portfolio, holdings, unrealized: +unrealizedTotal.toFixed(2) };
}

// Flash animations for price & P/L
function flashPrice(ticker, upOrDown) {
  const el = document.querySelector(`[data-stock="${ticker}"]`);
  if (el) {
    const cls = upOrDown === 'up' ? 'price-flash-up' : 'price-flash-down';
    el.classList.remove('price-flash-up', 'price-flash-down');
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 900);
  }

  const pl = document.querySelector(`[data-pl="${ticker}"]`);
  if (pl) {
    pl.classList.remove('pl-pop');
    void pl.offsetWidth;
    pl.classList.add('pl-pop');
    setTimeout(() => pl.classList.remove('pl-pop'), 700);
  }
}

// -----------------------
// Chart options (visible on dark bg)
// -----------------------
const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: {
      labels: { color: 'rgba(255,255,255,0.9)' }
    },
    tooltip: {
      backgroundColor: 'rgba(8,12,18,0.95)',
      titleColor: '#fff',
      bodyColor: '#e6eef8',
      mode: 'index',
      intersect: false
    }
  },
  scales: {
    x: {
      ticks: { color: 'rgba(255,255,255,0.78)', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
      grid: { color: 'rgba(255,255,255,0.04)' }
    },
    y: {
      ticks: { color: 'rgba(255,255,255,0.78)' },
      grid: { color: 'rgba(255,255,255,0.04)' }
    }
  },
  elements: {
    line: {
      borderWidth: 2.4,
      tension: 0.18,
      borderColor: '#7dd3fc', // bright cyan
      backgroundColor: 'rgba(125,211,252,0.06)'
    },
    point: {
      radius: 3,
      hoverRadius: 5,
      borderColor: '#38bdf8',
      backgroundColor: '#0ea5e9'
    }
  }
};

// -----------------------
// MAIN Component
// -----------------------
export default function Dashboard() {
  const email = getEmail();
  const token = getToken();

  const [connected, setConnected] = useState(false);
  const [supported, setSupported] = useState(['GOOG','TSLA','AMZN','META','NVDA']);
  const [prices, setPrices] = useState({});
  const [portfolio, setPortfolio] = useState({ cash:0, realized:0, holdings: [], unrealized:0 });
  const [selectedTicker, setSelectedTicker] = useState(supported[0]);
  const [history, setHistory] = useState([]);
  const [qty, setQty] = useState(1);
  const [tradeMsg, setTradeMsg] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [depositMsg, setDepositMsg] = useState('');
  const socketRef = useRef(null);

  // NOTE: candlestick integration (optional)
  // To enable candlesticks:
  // 1) npm install chartjs-chart-financial chartjs-adapter-date-fns
  // 2) import and register controllers/elements:
  //    import { CandlestickController, CandlestickElement } from 'chartjs-chart-financial';
  //    ChartJS.register(CandlestickController, CandlestickElement);
  // 3) Convert OHLC data to dataset: [{x: timestamp, o, h, l, c}, ...] and render Chart type 'candlestick'
  // I intentionally leave candlestick out by default to avoid runtime errors if the plugin isn't installed.

  // Connect socket & handlers
  useEffect(() => {
    if (!token) { window.location.href = '/login'; return; }

    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('getPrices');
      if (selectedTicker) socket.emit('getHistory', selectedTicker);
    });

    socket.on('disconnect', () => setConnected(false));

    // server broadcasts full price object every second
    socket.on('stockUpdate', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      setPrices(prevPrices => {
        // flash logic for changed tickers
        Object.keys(payload).forEach(t => {
          const prev = prevPrices[t] ?? 0;
          const neu = payload[t];
          if (neu > prev) flashPrice(t, 'up');
          else if (neu < prev) flashPrice(t, 'down');
        });

        const merged = { ...prevPrices, ...payload };
        // recalc portfolio immediately with merged prices
        setPortfolio(prevPort => recalcPortfolioWithPrices(prevPort, merged));
        return merged;
      });
    });

    // history (one-time)
    socket.on('history', ({ ticker, history }) => {
      if (ticker === selectedTicker) setHistory(Array.isArray(history) ? history : []);
    });

    // server also broadcasts 'historyUpdate' object every second (optional)
    socket.on('historyUpdate', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      if (selectedTicker && payload[selectedTicker]) {
        setHistory(Array.isArray(payload[selectedTicker]) ? payload[selectedTicker] : []);
      }
    });

    // full snapshot (optional)
    socket.on('prices', (all) => {
      if (all && typeof all === 'object') {
        setPrices(all);
        setPortfolio(prev => recalcPortfolioWithPrices(prev, all));
      }
    });

    // portfolio updates from server (on trade/deposit)
    socket.on('portfolioUpdate', (p) => {
      const norm = normalizePortfolio(p);
      const withCurrent = recalcPortfolioWithPrices(norm, prices);
      setPortfolio(withCurrent);
    });

    socket.on('tradeExecuted', (msg) => {
      setTradeMsg(`Trade executed: ${msg.type} ${msg.qty} ${msg.ticker} @ ${msg.price}`);
    });

    socket.on('connect_error', (err) => {
      console.error('socket connect_error', err && err.message ? err.message : err);
    });

    // initial /me fetch
    (async function fetchMe(){
      try {
        const res = await fetch(`${API}/me`, { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json();
        if (res.ok) {
          if (data.supported) {
            setSupported(data.supported);
            localStorage.setItem('supported', JSON.stringify(data.supported));
            if (!selectedTicker && data.supported.length) setSelectedTicker(data.supported[0]);
          }
          const norm = normalizePortfolio(data.portfolio);
          const withCurrent = recalcPortfolioWithPrices(norm, prices);
          setPortfolio(withCurrent);
        } else {
          console.warn('/me failed', data);
        }
      } catch (err) {
        console.error('fetch /me error', err);
      }
    })();

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedTicker]);

  // request one-time history when user switches ticker
  useEffect(() => {
    const socket = socketRef.current;
    if (socket && selectedTicker) socket.emit('getHistory', selectedTicker);
  }, [selectedTicker]);

  // trade / buy-sell
  async function doTrade(type) {
    setTradeMsg('');
    const q = Number(qty);
    if (!selectedTicker || !Number.isInteger(q) || q <= 0) { setTradeMsg('Invalid quantity'); return; }
    try {
      const res = await fetch(`${API}/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ type, ticker: selectedTicker, qty: q })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Trade failed');
      const norm = normalizePortfolio(data.portfolio);
      const withCurrent = recalcPortfolioWithPrices(norm, prices);
      setPortfolio(withCurrent);
      setTradeMsg(`Success: ${type} ${q} ${selectedTicker} @ ${data.trade.price}`);
    } catch (err) {
      setTradeMsg(err.message || String(err));
    }
  }

  // deposit cash
  async function depositCash() {
    setDepositMsg('');
    const amt = Number(depositAmount);
    if (!amt || amt <= 0) { setDepositMsg('Enter valid amount'); return; }
    try {
      const res = await fetch(`${API}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ amount: amt })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Deposit failed');
      const norm = normalizePortfolio(data.portfolio);
      const withCurrent = recalcPortfolioWithPrices(norm, prices);
      setPortfolio(withCurrent);
      setDepositMsg('Deposit successful');
      setDepositAmount('');
    } catch (err) {
      setDepositMsg(err.message || String(err));
    }
  }

  // Chart data (Line)
  const chartData = {
    labels: history.map((_, i) => i + 1),
    datasets: [
      {
        label: selectedTicker || 'Price',
        data: history,
        fill: true,
        borderColor: '#7dd3fc',
        backgroundColor: 'rgba(125,211,252,0.06)',
        pointBackgroundColor: '#0ea5e9',
        pointBorderColor: '#fff',
        pointRadius: 3,
        tension: 0.18,
      }
    ]
  };

  return (
    <div className="container">
      <div className="header">
        <h2>Stock Dashboard</h2>
        <div>
          <strong>{email}</strong>
          <button className="btn small" onClick={() => { localStorage.removeItem('token'); localStorage.removeItem('email'); window.location.href = '/login'; }}>Logout</button>
        </div>
      </div>

      <div className="status">Connection: <span className={connected ? 'connected' : 'disconnected'}>{connected ? 'Connected' : 'Disconnected'}</span></div>

      <div className="cols">
        <div className="col">
          <h3>Supported Stocks</h3>
          <ul className="list">
            {supported.map(t => (
              <li key={t} className="list-item" data-stock={t}>
                <div>
                  <strong style={{marginRight:8}}>{t}</strong>
                  <span className="muted">Latest: { (prices[t] ?? 0).toFixed ? (prices[t] ?? 0).toFixed(2) : String(prices[t] ?? '—') }</span>
                </div>
                <div>
                  <button className="btn small" style={{marginLeft:8}} onClick={() => setSelectedTicker(t)}>View</button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="col">
          <h3>Chart — {selectedTicker}</h3>
          <div className="chart-card" style={{height:320}}>
            <Line data={chartData} options={chartOptions} />
          </div>

          <h3 style={{marginTop:12}}>Trade Panel</h3>
          <div style={{display:'flex', gap:8, alignItems:'center'}}>
            <select value={selectedTicker} onChange={e => setSelectedTicker(e.target.value)}>
              {supported.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input type="number" value={qty} onChange={e => setQty(e.target.value)} style={{width:80}} />
            <button className="btn" onClick={() => doTrade('buy')}>Buy</button>
            <button className="btn" onClick={() => doTrade('sell')}>Sell</button>
          </div>
          <div className="muted" style={{marginTop:8}}>{tradeMsg}</div>

          <h3 style={{marginTop:12}}>Portfolio</h3>

          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:12}}>
            <div>
              <div>Cash: ${portfolio.cash?.toFixed(2) ?? '0.00'}</div>
              <div style={{marginTop:6}}>
                <strong>Holdings</strong>
              </div>
            </div>

            <div style={{minWidth:240}}>
              <label style={{display:'block',fontSize:13}}>Add Cash</label>
              <div style={{display:'flex', gap:8, marginTop:6}}>
                <input type="number" value={depositAmount} onChange={e => setDepositAmount(e.target.value)} placeholder="Amount" style={{padding:6, width:140}} />
                <button className="btn" onClick={depositCash}>Add Cash</button>
              </div>
              {depositMsg && <div style={{marginTop:8, color: depositMsg.includes('successful') ? 'green' : 'red'}}>{depositMsg}</div>}
            </div>
          </div>

          <table className="table" style={{marginTop:10}}>
            <thead>
              <tr><th>Ticker</th><th>Qty</th><th>Price</th><th>P/L</th></tr>
            </thead>
            <tbody>
              { (!portfolio.holdings || portfolio.holdings.length === 0) && <tr><td colSpan={4}>No holdings</td></tr> }
              { (portfolio.holdings || []).map(h => (
                <tr key={h.ticker}>
                  <td>{h.ticker}</td>
                  <td>{h.qty}</td>
                  <td>${(h.current_price || prices[h.ticker] || 0).toFixed(2)}</td>
                  <td data-pl={h.ticker} className={ (h.unrealized < 0) ? 'pl-negative' : 'pl-positive' }>${(h.unrealized || 0).toFixed(2)}</td>
                </tr>
              )) }
            </tbody>
          </table>

          <div style={{marginTop:8, fontSize:13, color:'#666'}}>
            <strong>Unrealized:</strong> {portfolio.unrealized != null ? portfolio.unrealized.toFixed(2) : '0.00'} &nbsp;&nbsp;
            <strong>Realized:</strong> {portfolio.realized != null ? portfolio.realized.toFixed(2) : '0.00'}
          </div>

        </div>
      </div>

      <div className="note" style={{marginTop:16}}>Tip: Open another browser/incognito and login with another user to test asynchronous updates.</div>
    </div>
  );
}
*/
import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend
} from "chart.js";
import "./index.css";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const TICKERS = ["GOOG", "TSLA", "AMZN", "META", "NVDA"];
const token = () => localStorage.getItem("token");
const email = () => localStorage.getItem("email");

export default function Dashboard() {
  const [prices, setPrices] = useState({});
  const [history, setHistory] = useState({});
  const [portfolio, setPortfolio] = useState(null);
  const [selected, setSelected] = useState("GOOG");

  const [showTrades, setShowTrades] = useState(false);
  const [trades, setTrades] = useState([]);

  const socketRef = useRef(null);

  /* ---------------- SOCKET + DATA ---------------- */
  useEffect(() => {
    if (!token()) {
      window.location.href = "/login";
      return;
    }

    fetch("/me", { headers: { Authorization: "Bearer " + token() } })
      .then(r => r.json())
      .then(d => setPortfolio(d.portfolio));

    const socket = io({ auth: { token: token() } });
    socketRef.current = socket;

    socket.on("stockUpdate", setPrices);
    socket.on("historyUpdate", setHistory);
    socket.on("portfolioUpdate", setPortfolio);

    return () => socket.disconnect();
  }, []);

  /* ---------------- TRENDING STOCK ---------------- */
  const trending = (() => {
    let best = null;
    let bestPct = 0;

    TICKERS.forEach(t => {
      const h = history[t];
      if (!h || h.length < 6) return;
      const old = h[h.length - 6];
      const cur = h[h.length - 1];
      const pct = ((cur - old) / old) * 100;
      if (pct > bestPct) {
        bestPct = pct;
        best = t;
      }
    });

    return best ? { ticker: best, pct: bestPct.toFixed(2) } : null;
  })();

  /* ---------------- TRANSACTION HISTORY ---------------- */
  async function loadTrades() {
    const res = await fetch("/trades", {
      headers: { Authorization: "Bearer " + token() }
    });
    const data = await res.json();
    setTrades(data.trades || []);
    setShowTrades(true);
  }

  /* ---------------- CHART ---------------- */
  const chartData = {
    labels: (history[selected] || []).map((_, i) => i + 1),
    datasets: [
      {
        label: selected,
        data: history[selected] || [],
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56,189,248,0.15)",
        tension: 0.35,
        pointRadius: 0
      }
    ]
  };

  return (
    <div className="container">
      <div className="header">
        <h2>Stock Dashboard</h2>
        <div>
          <strong>{email()}</strong>
          <button className="btn small" onClick={() => {
            localStorage.clear();
            window.location.href = "/login";
          }}>Logout</button>
        </div>
      </div>

      {/* 🔥 TRENDING */}
      {trending && (
        <div className="trending">
          🔥 Trending: <strong>{trending.ticker}</strong> (+{trending.pct}%)
          <span className="muted"> — Consider Buying</span>
        </div>
      )}

      {/* STOCK CARDS */}
      <div className="grid">
        {TICKERS.map(t => (
          <div
            key={t}
            className={`card stock-card ${selected === t ? "active" : ""}`}
            onClick={() => setSelected(t)}
          >
            <div>{t}</div>
            <div>${prices[t]?.toFixed(2)}</div>
          </div>
        ))}
      </div>

      {/* CHART */}
      <div className="card chart-card">
        <h3>{selected} Price Chart</h3>
        <Line data={chartData} options={{ responsive: true, plugins: { legend: { display: false }}}} />
      </div>

      {/* PORTFOLIO */}
      {portfolio && (
        <div className="card">
          <h3>Portfolio</h3>
          <div>Cash: ${portfolio.cash.toFixed(2)}</div>
          <div className={portfolio.unrealized >= 0 ? "pl-positive" : "pl-negative"}>
            Unrealized P/L: {portfolio.unrealized.toFixed(2)}
          </div>

          <table className="table">
            <thead>
              <tr><th>Ticker</th><th>Qty</th><th>Price</th><th>P/L</th></tr>
            </thead>
            <tbody>
              {portfolio.holdings.map(h => (
                <tr key={h.ticker}>
                  <td>{h.ticker}</td>
                  <td>{h.qty}</td>
                  <td>${h.current_price.toFixed(2)}</td>
                  <td className={h.unrealized >= 0 ? "pl-positive" : "pl-negative"}>
                    {h.unrealized.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button className="btn" onClick={loadTrades}>
            View Transaction History
          </button>
        </div>
      )}

      {/* TRANSACTION MODAL */}
      {showTrades && (
        <div className="modal-backdrop">
          <div className="modal large">
            <h3>Transaction History</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th><th>Ticker</th><th>Qty</th><th>Price</th><th>Date</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={i}>
                    <td className={t.type === "buy" ? "pl-positive" : "pl-negative"}>
                      {t.type.toUpperCase()}
                    </td>
                    <td>{t.ticker}</td>
                    <td>{t.qty}</td>
                    <td>${t.price.toFixed(2)}</td>
                    <td>{new Date(t.ts).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn secondary" onClick={() => setShowTrades(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
