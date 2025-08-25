const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cookieParser = require("cookie-parser");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- simple JSON “DB” ---
const DB_FILE = path.join(__dirname, "db.json");
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
  res.sendFile(path.join(__dirname, "backend.html")),
);

// initialize or lookup user, grant 10 AUP once
app.get("/init", (req, res) => {
  let userId = req.cookies.userId;
  let firstTime = false;
  if (!userId || !db[userId]) {
    userId = uuidv4();
    const uuid = uuidv4(); // “password” to redeem IRL staff
    db[userId] = { uuid, balance: 10 }; // start with 10 AUP
    saveDB();
    res.cookie("userId", userId, { httpOnly: true });
    firstTime = true;
  }
  const { uuid, balance } = db[userId];
  res.json({ userId, uuid, balance, firstTime });
});

// admin charging endpoint
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
let bettors = {}; // userId -> bet amount
let sockets = {}; // ws -> userId
let timer = null;
let timeLeft = 30;

// broadcast helper
function broadcast(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(str);
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
    broadcast({ type: "round-cancelled" });
    return;
  }
  const total = entries.reduce((sum, [_, b]) => sum + b, 0);
  // subtract all bets
  entries.forEach(([uid, bet]) => (db[uid].balance -= bet));
  // pick weighted random
  let rand = Math.random() * total;
  let winner = entries.find(([_, bet]) => {
    rand -= bet;
    return rand <= 0;
  })[0];
  // award pot
  db[winner].balance += total;
  saveDB();

  broadcast({ type: "round-result", winner, total });
  // update everyone’s balance
  Object.values(sockets).forEach((uid) => {
    const sock = Object.keys(sockets).find((k) => sockets[k] === uid);
    if (sock && db[uid]) {
      ws = Array.from(wss.clients).find((c) => sockets[c] === uid);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "balance-update", balance: db[uid].balance }),
        );
      }
    }
  });

  bettors = {};
}

// WebSocket logic
wss.on("connection", (ws, req) => {
  // map ws -> userId
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === "join") {
      const userId = msg.userId;
      sockets[ws] = userId;
    }
    if (msg.type === "place-bet") {
      const uid = sockets[ws];
      const amt = Number(msg.amount);
      if (!uid || amt <= 0 || amt > db[uid].balance) {
        return ws.send(
          JSON.stringify({ type: "error", message: "Invalid bet" }),
        );
      }
      if (bettors[uid]) {
        return ws.send(
          JSON.stringify({ type: "error", message: "Already placed a bet" }),
        );
      }
      bettors[uid] = amt;
      broadcast({ type: "new-bet", userId: uid, amount: amt });
      // start countdown on first bet
      if (Object.keys(bettors).length === 1) startGame();
    }
  });

  ws.on("close", () => {
    delete sockets[ws];
  });
});

server.listen(3000, () => console.log("Listening on http://localhost:3000"));
