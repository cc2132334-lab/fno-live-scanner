const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const https = require("https");

const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// GLOBAL STATE
// ============================================================

let currentSession = null;

let fnoUniverse = [];
let cashUniverse = [];

let cashByUnderlying = new Map();
let cashByToken = new Map();

let volumeData = new Map();
let volumeHistory = new Map();

let priceData = new Map();

let cashWebSocket = null;
let websocketRunning = false;

const VOLUME_LOOKBACK_MS = 30 * 1000;
const MAX_HISTORY_PER_STOCK = 20;

// ============================================================
// HELPERS
// ============================================================

function cleanSymbol(symbol) {
  if (!symbol) return "";

  return String(symbol)
    .replace(/-EQ$/i, "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function safePercent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeApiData(result) {
  if (!result) return [];

  if (Array.isArray(result)) return result;

  if (Array.isArray(result.data)) return result.data;

  return [];
}

// ============================================================
// SCRIP MASTER
// ============================================================

async function loadScripMaster() {
  return new Promise((resolve, reject) => {
    https
      .get(
        "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json",
        (res) => {
          let body = "";

          res.on("data", (chunk) => {
            body += chunk;
          });

          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              resolve(data);
            } catch (err) {
              reject(err);
            }
          });
        }
      )
      .on("error", reject);
  });
}

// ============================================================
// BUILD F&O -> NSE CASH MAPPING
// ============================================================

async function buildUniverse() {
  console.log("Loading Angel One scrip master...");

  const master = await loadScripMaster();

  const nseCash = master.filter(
    (item) =>
      item &&
      item.exch_seg === "NSE" &&
      typeof item.symbol === "string" &&
      item.symbol.endsWith("-EQ")
  );

  const nseCashMap = new Map();

  for (const item of nseCash) {
    const underlying = cleanSymbol(item.name || item.symbol);

    if (!underlying) continue;

    nseCashMap.set(underlying, {
      symbol: item.symbol,
      token: String(item.token),
      name: underlying,
    });
  }

  const futures = master.filter(
    (item) =>
      item &&
      item.exch_seg === "NFO" &&
      item.instrumenttype === "FUTSTK"
  );

  const unique = new Map();

  for (const fut of futures) {
    const underlying = cleanSymbol(fut.name);

    if (!underlying) continue;

    const cash = nseCashMap.get(underlying);

    if (!cash) continue;

    if (!unique.has(underlying)) {
      unique.set(underlying, {
        underlying,
        cashSymbol: cash.symbol,
        cashToken: cash.token,
        cashName: cash.name,
      });
    }
  }

  fnoUniverse = Array.from(unique.values());
  cashUniverse = fnoUniverse;

  cashByUnderlying.clear();
  cashByToken.clear();

  for (const item of cashUniverse) {
    cashByUnderlying.set(item.underlying, item);

    cashByToken.set(String(item.cashToken), item);
  }

  console.log(
    `F&O eligible NSE cash stocks loaded: ${cashUniverse.length}`
  );
}

// ============================================================
// LOGIN
// ============================================================

app.post("/api/login", async (req, res) => {
  try {
    const { apiKey, clientId, mpin, totp } = req.body;

    if (!apiKey || !clientId || !mpin || !totp) {
      return res.status(400).json({
        success: false,
        message: "API Key, Client ID, MPIN and TOTP are required.",
      });
    }

    console.log("Logging into Angel One...");

    const smartApi = new SmartAPI({
      api_key: apiKey,
    });

    const loginResponse = await smartApi.generateSession(
      clientId,
      mpin,
      totp
    );

    if (!loginResponse || loginResponse.status !== true) {
      console.log("Angel One login failed:", loginResponse);

      return res.status(401).json({
        success: false,
        message:
          loginResponse?.message ||
          loginResponse?.errorcode ||
          "Angel One login failed.",
      });
    }

    const data = loginResponse.data || {};

    currentSession = {
      apiKey,
      clientId,
      jwtToken: data.jwtToken,
      refreshToken: data.refreshToken,
      feedToken: data.feedToken,
      smartApi,
    };

    console.log("Angel One login successful.");

    // Start live NSE cash feed
    startCashWebSocket();

    return res.json({
      success: true,
      message: "Angel One connected.",
      cashStocks: cashUniverse.length,
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    currentSession = null;

    return res.status(500).json({
      success: false,
      message: error.message || "Login failed.",
    });
  }
});

// ============================================================
// LIVE NSE CASH WEBSOCKET
// ============================================================

function startCashWebSocket() {
  if (!currentSession) {
    console.log("No session. WebSocket not started.");
    return;
  }

  if (cashWebSocket) {
    try {
      cashWebSocket.close();
    } catch (e) {}
  }

  try {
    console.log(
      `Starting NSE cash WebSocket for ${cashUniverse.length} stocks...`
    );

    cashWebSocket = new WebSocketV2({
      jwttoken: currentSession.jwtToken,
      apikey: currentSession.apiKey,
      clientcode: currentSession.clientId,
      feedtype: currentSession.feedToken,
    });

    cashWebSocket.on("tick", handleCashTick);

    cashWebSocket
      .connect()
      .then(() => {
        websocketRunning = true;

        console.log("NSE cash WebSocket connected.");

        subscribeCashTokens();
      })
      .catch((err) => {
        websocketRunning = false;
        console.error("WebSocket connect error:", err);
      });
  } catch (error) {
    websocketRunning = false;
    console.error("WebSocket start error:", error);
  }
}

// ============================================================
// SUBSCRIBE NSE CASH TOKENS
// ============================================================

function subscribeCashTokens() {
  if (!cashWebSocket || !cashUniverse.length) return;

  const tokens = cashUniverse.map((item) =>
    String(item.cashToken)
  );

  // Angel One WebSocket supports batches.
  const BATCH_SIZE = 100;

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);

    const request = {
      correlationID: `cash_${Date.now()}_${i}`,
      action: 1,
      mode: 3,
      exchangeType: 1,
      tokens: batch,
    };

    try {
      cashWebSocket.fetchData(request);

      console.log(
        `Subscribed NSE cash tokens: ${batch.length}`
      );
    } catch (error) {
      console.error("Subscription error:", error);
    }
  }
}

// ============================================================
// PARSE LIVE CASH TICK
// ============================================================

function handleCashTick(tick) {
  try {
    if (!tick) return;

    let data = tick;

    // Some SDK versions can emit an object directly.
    if (Buffer.isBuffer(data)) {
      data = JSON.parse(data.toString());
    }

    if (typeof data === "string") {
      data = JSON.parse(data);
    }

    if (!data || typeof data !== "object") return;

    const token =
      data.token ??
      data.symbolToken ??
      data.symboltoken;

    if (!token) return;

    const tokenKey = String(token);

    const stock = cashByToken.get(tokenKey);

    if (!stock) return;

    // WebSocket V2 prices are generally paise-scaled.
    let ltp = numberValue(
      data.last_traded_price ??
        data.lastTradedPrice ??
        data.ltp ??
        data.lastTradedPrice
    );

    if (ltp > 100000) {
      ltp = ltp / 100;
    }

    let volume = numberValue(
      data.vol_traded ??
        data.volume_traded ??
        data.tradeVolume ??
        data.volume
    );

    let percentChange = numberValue(
      data.percent_change ??
        data.percentChange ??
        data.changePercent
    );

    let netChange = numberValue(
      data.net_change ??
        data.netChange ??
        data.change
    );

    // Some WebSocket feeds send price/change in paise.
    if (Math.abs(netChange) > 10000) {
      netChange = netChange / 100;
    }

    // If percent change is missing but close exists, calculate it.
    const close = numberValue(
      data.close_price ??
        data.close ??
        data.prev_close ??
        data.previousClose
    );

    if (!percentChange && close > 0 && ltp > 0) {
      percentChange = ((ltp - close) / close) * 100;
    }

    const now = Date.now();

    priceData.set(stock.underlying, {
      symbol: stock.underlying,
      cashSymbol: stock.cashSymbol,
      token: stock.cashToken,
      price: ltp,
      change: netChange,
      changePercent: percentChange,
      volume,
      updatedAt: now,
    });

    // --------------------------------------------------------
    // Volume history
    // --------------------------------------------------------

    if (volume > 0) {
      volumeData.set(stock.underlying, {
        symbol: stock.underlying,
        cashSymbol: stock.cashSymbol,
        token: stock.cashToken,
        volume,
        price: ltp,
        changePercent: percentChange,
        updatedAt: now,
      });

      if (!volumeHistory.has(stock.underlying)) {
        volumeHistory.set(stock.underlying, []);
      }

      const history = volumeHistory.get(stock.underlying);

      const last = history[history.length - 1];

      if (!last || now - last.time >= 1000) {
        history.push({
          time: now,
          volume,
        });
      }

      while (history.length > MAX_HISTORY_PER_STOCK) {
        history.shift();
      }

      while (
        history.length &&
        now - history[0].time > 5 * 60 * 1000
      ) {
        history.shift();
      }
    }
  } catch (error) {
    console.error("Tick parse error:", error.message);
  }
}

// ============================================================
// OI GAINERS
// ============================================================

app.get("/api/oi-gainers", async (req, res) => {
  try {
    if (!currentSession?.smartApi) {
      return res.status(401).json({
        success: false,
        message: "Please login first.",
      });
    }

    const result = await currentSession.smartApi.gainersLosers({
      datatype: "PercOIGainers",
      expirytype: "NEAR",
    });

    const rows = normalizeApiData(result);

    const output = rows
      .map((item) => {
        const underlying = cleanSymbol(
          String(item.tradingSymbol || "").replace(
            /[0-9]{2}[A-Z]{3}[0-9]{2}FUT$/i,
            ""
          )
        );

        const price = priceData.get(underlying);

        return {
          symbol: underlying,

          // OI data
          oiPercent: safePercent(item.percentChange),
          openInterest: numberValue(item.opnInterest),
          netChangeOpenInterest: numberValue(
            item.netChangeOpnInterest
          ),

          // LIVE CASH PRICE
          price: price?.price ?? null,
          change: price?.change ?? null,
          changePercent: price?.changePercent ?? null,

          updatedAt: price?.updatedAt ?? null,
        };
      })
      .filter((item) => item.symbol)
      .sort((a, b) => b.oiPercent - a.oiPercent)
      .slice(0, 10);

    return res.json({
      success: true,
      data: output,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.error("OI GAINERS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to load OI gainers.",
    });
  }
});

// ============================================================
// OI LOSERS
// ============================================================

app.get("/api/oi-losers", async (req, res) => {
  try {
    if (!currentSession?.smartApi) {
      return res.status(401).json({
        success: false,
        message: "Please login first.",
      });
    }

    const result = await currentSession.smartApi.gainersLosers({
      datatype: "PercOILosers",
      expirytype: "NEAR",
    });

    const rows = normalizeApiData(result);

    const output = rows
      .map((item) => {
        const underlying = cleanSymbol(
          String(item.tradingSymbol || "").replace(
            /[0-9]{2}[A-Z]{3}[0-9]{2}FUT$/i,
            ""
          )
        );

        const price = priceData.get(underlying);

        return {
          symbol: underlying,

          // OI data
          oiPercent: safePercent(item.percentChange),
          openInterest: numberValue(item.opnInterest),
          netChangeOpenInterest: numberValue(
            item.netChangeOpnInterest
          ),

          // LIVE CASH PRICE
          price: price?.price ?? null,
          change: price?.change ?? null,
          changePercent: price?.changePercent ?? null,

          updatedAt: price?.updatedAt ?? null,
        };
      })
      .filter((item) => item.symbol)

      // MOST NEGATIVE FIRST
      .sort((a, b) => a.oiPercent - b.oiPercent)

      .slice(0, 10);

    return res.json({
      success: true,
      data: output,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.error("OI LOSERS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to load OI losers.",
    });
  }
});

// ============================================================
// VOLUME GAINERS
// ============================================================

function getOldVolume(symbol) {
  const history = volumeHistory.get(symbol);

  if (!history || history.length < 2) {
    return null;
  }

  const now = Date.now();
  const targetTime = now - VOLUME_LOOKBACK_MS;

  let candidate = history[0];

  for (const item of history) {
    if (item.time <= targetTime) {
      candidate = item;
    }
  }

  return candidate;
}

function getVolumeGainers() {
  const results = [];

  for (const [symbol, current] of volumeData.entries()) {
    if (!current || current.volume <= 0) continue;

    const old = getOldVolume(symbol);

    if (!old) continue;

    const increase = current.volume - old.volume;

    if (increase <= 0) continue;

    const percent =
      old.volume > 0
        ? (increase / old.volume) * 100
        : 0;

    results.push({
      symbol,
      price: current.price,
      changePercent: current.changePercent,
      currentVolume: current.volume,
      previousVolume: old.volume,
      volumeIncrease: increase,
      volumePercent: percent,
      updatedAt: current.updatedAt,
    });
  }

  results.sort(
    (a, b) => b.volumePercent - a.volumePercent
  );

  return results.slice(0, 10);
}

app.get("/api/volume-gainers", (req, res) => {
  try {
    const data = getVolumeGainers();

    return res.json({
      success: true,
      data,
      intervalSeconds: VOLUME_LOOKBACK_MS / 1000,
      collecting: data.length === 0,
      liveStocks: priceData.size,
      historyStocks: volumeHistory.size,
      websocketRunning,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.error("VOLUME ERROR:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to calculate volume gainers.",
    });
  }
});

// ============================================================
// STATUS
// ============================================================

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    loggedIn: !!currentSession,
    websocketRunning,
    fnoStocks: fnoUniverse.length,
    liveCashStocks: priceData.size,
    historyStocks: volumeHistory.size,
    updatedAt: Date.now(),
  });
});

// ============================================================
// LOGOUT
// ============================================================

app.post("/api/logout", async (req, res) => {
  try {
    if (cashWebSocket) {
      try {
        cashWebSocket.close();
      } catch (e) {}
    }

    cashWebSocket = null;
    websocketRunning = false;

    currentSession = null;

    priceData.clear();
    volumeData.clear();
    volumeHistory.clear();

    res.json({
      success: true,
      message: "Logged out.",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ============================================================
// FALLBACK FRONTEND
// Express 5 compatible wildcard
// ============================================================

app.get("/{*splat}", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  try {
    await buildUniverse();

    app.listen(PORT, () => {
      console.log(
        `F&O Live Scanner running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Failed to build F&O universe:",
      error
    );

    // Server still starts so Render doesn't immediately fail.
    app.listen(PORT, () => {
      console.log(
        `Server running on port ${PORT}, but scrip master failed.`
      );
    });
  }
}

startServer();
