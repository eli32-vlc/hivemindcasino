const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

// WebSocket server binds to the same HTTP server
const wss = new WebSocket.Server({ server });

// --- simple JSON “DB” ---
const DB_FILE = path.join(__dirname, "/mnt/db/db.json");
let db = {};
try {
  db = JSON.parse(fs.readFileSync(DB_FILE));
} catch {
  db = {};
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// --- config ---
const API_TOKEN = "^iGSKcJ&84YT72YumD%P";

// --- middleware ---
app.use(cookieParser());
app.use(express.json());
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/backend.html", (req, res) =>
  res.sendFile(path.join(__dirname, "backend.html"))
);
app.get("/init", (req, res) => {
  let userId = req.cookies.userId;
  let firstTime = false;
  if (!userId || !db[userId]) {
    userId = uuidv4();
    const uuid = uuidv4();
    db[userId] = { uuid, balance: 10 };
    saveDB();
    res.cookie("userId", userId, { httpOnly: true });
    firstTime = true;
  }
  const { uuid, balance } = db[userId];
  res.json({ userId, uuid, balance, firstTime });
});

app.post("/charge", (req, res) => {
  const { userId, amount, token } = req.body;
  if (token !== API_TOKEN)
    return res.status(401).json({ error: "Invalid token" });
  if (!db[userId]) return res.status(400).json({ error: "User not found" });
  db[userId].balance += Number(amount);
  saveDB();
  res.json({ success: true, balance: db[userId].balance });
});

// --- Game state ---
let bettors = {};            // userId -> bet amount
const sockets = new Map();   // WebSocket -> userId
let timer = null;
let timeLeft = 30;

// broadcast helper
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(raw);
  });
}

// start countdown
function startGame() {
  if (timer) return;
  timeLeft = 30;
  broadcast({ type: "timer", timeLeft });
  timer = setInterval(() => {
    timeLeft--;
    broadcast({ type: "timer", timeLeft });
    if (timeLeft <= 0) {
      clearInterval(timer);
      timer = null;
      endGame();
    }
  }, 1000);
}

// resolve round
function endGame() {
  const entries = Object.entries(bettors);
  if (entries.length < 2) {
    bettors = {};
    return broadcast({ type: "round-cancelled" });
  }
  const total = entries.reduce((sum, [_, b]) => sum + b, 0);
  entries.forEach(([uid, bet]) => (db[uid].balance -= bet));

  let rand = Math.random() * total;
  const [winner] = entries.find(([_, bet]) => {
    rand -= bet;
    return rand <= 0;
  });
  db[winner].balance += total;
  saveDB();

  broadcast({ type: "round-result", winner, total });

  // update individual balances
  for (let [ws, uid] of sockets.entries()) {
    if (db[uid] && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "balance-update", balance: db[uid].balance })
      );
    }
  }

  bettors = {};
}

// heartbeat
function heartbeat() {
  this.isAlive = true;
}

// WebSocket logic
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  console.log("➤ new WS connection from", req.socket.remoteAddress);
  // send a welcome message so client sees something immediately
  ws.send(JSON.stringify({ type: "welcome", message: "Hello from server!" }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return ws.send(JSON.stringify({ type: "error", message: "Bad JSON" }));
    }
    console.log("◉ recv:", msg);

    if (msg.type === "join") {
      sockets.set(ws, msg.userId);
      return ws.send(JSON.stringify({ type: "joined", userId: msg.userId }));
    }

    if (msg.type === "place-bet") {
      const uid = sockets.get(ws);
      const amt = Number(msg.amount);
      if (!uid || amt <= 0 || amt > db[uid].balance) {
        return ws.send(
          JSON.stringify({ type: "error", message: "Invalid bet" })
        );
      }
      if (bettors[uid]) {
        return ws.send(
          JSON.stringify({ type: "error", message: "Already placed a bet" })
        );
      }
      bettors[uid] = amt;
      broadcast({ type: "new-bet", userId: uid, amount: amt });
      if (Object.keys(bettors).length === 1) startGame();
    }

    // catch-all for unknown types
    else {
      ws.send(JSON.stringify({ type: "error", message: "Unknown type" }));
    }
  });

  ws.on("close", () => {
    console.log("✖ WS closed for", sockets.get(ws));
    sockets.delete(ws);
  });
});

// ping clients every 30s and terminate dead ones
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Listening on http://localhost:${PORT}`)
);
