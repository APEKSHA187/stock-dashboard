# Stock Broker Client Web Dashboard

A real-time stock trading simulation web application built using React, Node.js, Socket.IO, and SQLite.

## Live Application
https://stock-dashboard-hiph.onrender.com

## Features
- Email-based authentication (JWT)
- Real-time stock price updates (every second)
- Supported stocks: GOOG, TSLA, AMZN, META, NVDA
- Buy and sell stocks with virtual cash
- Live portfolio profit/loss calculation
- Interactive stock price charts
- Transaction history modal
- Trending stock suggestion
- Multi-user support

## Tech Stack
Frontend: React, Chart.js, Socket.IO Client  
Backend: Node.js, Express, Socket.IO  
Database: SQLite

## Local Setup
```bash
git clone https://github.com/<your-username>/stock-dashboard.git
cd stock-dashboard
cd server
npm install
node server.js
