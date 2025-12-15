import React, { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';

const API = 'http://localhost:4000';

function getToken(){ return localStorage.getItem('token'); }
function getEmail(){ return localStorage.getItem('email'); }
function getSupported(){ try { return JSON.parse(localStorage.getItem('supported')) || []; } catch { return []; } }

export default function Dashboard(){
  const email = getEmail();
  const token = getToken();
  const supported = getSupported();
  const [connected, setConnected] = useState(false);
  const [subs, setSubs] = useState([]);
  const [prices, setPrices] = useState({});
  const socketRef = useRef(null);
  const prevPricesRef = useRef({});

  useEffect(() => {
    if (!token) { window.location.href = '/login'; return; }
    const socket = io(API, { auth: { token } , transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('getPrices');
    });

    socket.on('disconnect', () => setConnected(false));
    socket.on('stockUpdate', (payload) => {
      setPrices(prev => ({ ...prev, ...payload }));
    });

    socket.on('prices', (all) => {
      setPrices(all);
    });

    socket.on('subscribed', list => {
      setSubs(list);
    });

    socket.on('connect_error', (err) => {
      console.error('connect_error', err.message);
    });

    return () => {
      socket.disconnect();
    };
  }, [token]);

  function toggleSubscribe(ticker) {
    const socket = socketRef.current;
    if (!socket) return;
    if (subs.includes(ticker)) {
      socket.emit('unsubscribe', [ticker]);
      setSubs(s => s.filter(x => x !== ticker));
    } else {
      socket.emit('subscribe', [ticker]);
      setSubs(s => [...s, ticker]);
    }
  }

  function priceDeltaStyle(ticker) {
    const prev = prevPricesRef.current[ticker];
    const cur = prices[ticker];
    if (prev == null) return {};
    if (cur > prev) return { color: 'green' };
    if (cur < prev) return { color: 'red' };
    return {};
  }

  useEffect(() => {
    prevPricesRef.current = { ...prevPricesRef.current, ...prices };
  }, [prices]);

  function logout(){
    localStorage.removeItem('token');
    localStorage.removeItem('email');
    window.location.href = '/login';
  }

  return (
    <div className="container">
      <div className="header">
        <h2>Stock Dashboard</h2>
        <div>
          <strong>{email}</strong>
          <button className="btn small" onClick={logout}>Logout</button>
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
                  <strong>{t}</strong>
                  <div className="muted">Latest: {prices[t] ?? '—'}</div>
                </div>
                <div>
                  <button className="btn small" onClick={() => toggleSubscribe(t)}>{subs.includes(t) ? 'Unsubscribe' : 'Subscribe'}</button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="col">
          <h3>Your Subscriptions</h3>
          {subs.length === 0 && <div>No subscriptions yet.</div>}
          <table className="table">
            <thead><tr><th>Ticker</th><th>Price</th></tr></thead>
            <tbody>
              {subs.map(t => (
                <tr key={t}>
                  <td>{t}</td>
                  <td style={priceDeltaStyle(t)}>{prices[t] ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="note">Tip: Open another browser/Incognito, login with another email and subscribe to different stocks to see asynchronous updates.</div>
    </div>
  );
}
