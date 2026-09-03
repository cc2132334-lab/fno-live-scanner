const express = require("express");
const cors = require("cors");
const https = require("https");

const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");
const { generate } = require("otplib");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// ============================================================
// GLOBAL STATE
// ============================================================

let currentSession = null;

let fnoUniverse = [];
let cashUniverse = [];

const cashByUnderlying = new Map();
const cashByToken = new Map();

const priceData = new Map();

const volumeData = new Map();
const volumeHistory = new Map();

let cashWebSocket = null;
let websocketRunning = false;

const VOLUME_LOOKBACK_MS = 30 * 1000;
const MAX_HISTORY_PER_STOCK = 60;

// ============================================================
// BASIC HELPERS
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

function percentValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeApiData(result) {
  if (!result) return [];

  if (Array.isArray(result)) {
    return result;
  }

  if (Array.isArray(result.data)) {
    return result.data;
  }

  return [];
}

// ============================================================
// FUTURE SYMBOL -> UNDERLYING
// ============================================================

function getUnderlyingFromFutureSymbol(symbol) {
  if (!symbol) return "";

  const value = String(symbol)
    .trim()
    .toUpperCase();

  // Example:
  // HEROMOTOCO29SEP26FUT
  // ->
  // HEROMOTOCO

  let underlying = value.replace(
    /\d{2}[A-Z]{3}\d{2}FUT$/i,
    ""
  );

  if (underlying === value) {
    underlying = value.replace(
      /FUT$/i,
      ""
    );
  }

  return cleanSymbol(underlying);
}

// ============================================================
// TOTP SECRET NORMALIZATION
// ============================================================

function normalizeTotpSecret(input) {
  if (!input) return "";

  let value = String(input).trim();

  // If user pasted an otpauth URI:
  //
  // otpauth://totp/AngelOne?secret=XXXX
  //
  // extract only the secret.

  const secretMatch = value.match(
    /(?:secret=)([A-Za-z2-7]+)(?:&|$)/i
  );

  if (secretMatch && secretMatch[1]) {
    value = secretMatch[1];
  }

  // Remove spaces/new lines.
  value = value.replace(/\s+/g, "");

  // Remove hyphens if pasted as grouped secret.
  value = value.replace(/-/g, "");

  // Remove accidental "=" padding.
  value = value.replace(/=/g, "");

  return value.toUpperCase();
}

// ============================================================
// LOAD ANGEL ONE SCRIP MASTER
// ============================================================

function loadScripMaster() {
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
            } catch (error) {
              reject(error);
            }

          });
        }
      )
      .on("error", reject);
  });
}

// ============================================================
// BUILD F&O ELIGIBLE CASH UNIVERSE
// ============================================================

async function buildUniverse() {

  console.log(
    "Loading Angel One scrip master..."
  );

  const master =
    await loadScripMaster();

  if (!Array.isArray(master)) {
    throw new Error(
      "Invalid Angel One scrip master."
    );
  }

  // ----------------------------------------------------------
  // NSE CASH EQUITY
  // ----------------------------------------------------------

  const nseCash =
    master.filter(
      (item) =>
        item &&
        item.exch_seg === "NSE" &&
        typeof item.symbol === "string" &&
        item.symbol
          .toUpperCase()
          .endsWith("-EQ")
    );

  const nseCashMap =
    new Map();

  for (const item of nseCash) {

    const underlying =
      cleanSymbol(
        item.name ||
        item.symbol
      );

    if (!underlying) continue;

    nseCashMap.set(
      underlying,
      {
        underlying,
        cashSymbol:
          item.symbol,
        cashToken:
          String(item.token),
      }
    );
  }

  // ----------------------------------------------------------
  // NSE STOCK FUTURES
  // ----------------------------------------------------------

  const futures =
    master.filter(
      (item) =>
        item &&
        item.exch_seg === "NFO" &&
        item.instrumenttype === "FUTSTK"
    );

  const unique =
    new Map();

  for (const future of futures) {

    const underlying =
      cleanSymbol(
        future.name
      );

    if (!underlying) continue;

    const cash =
      nseCashMap.get(
        underlying
      );

    if (!cash) continue;

    if (!unique.has(underlying)) {

      unique.set(
        underlying,
        {
          underlying,
          cashSymbol:
            cash.cashSymbol,
          cashToken:
            cash.cashToken,
        }
      );

    }
  }

  fnoUniverse =
    Array.from(
      unique.values()
    );

  cashUniverse =
    fnoUniverse;

  cashByUnderlying.clear();
  cashByToken.clear();

  for (const stock of cashUniverse) {

    cashByUnderlying.set(
      stock.underlying,
      stock
    );

    cashByToken.set(
      String(stock.cashToken),
      stock
    );
  }

  console.log(
    `F&O eligible NSE cash stocks: ${cashUniverse.length}`
  );
}

// ============================================================
// ANGEL ONE LOGIN
// ============================================================

app.post(
  "/api/login",
  async (req, res) => {

    try {

      const {
        apiKey,
        clientId,
        mpin,
        totpSecret
      } = req.body;

      // ------------------------------------------------------
      // VALIDATION
      // ------------------------------------------------------

      if (!apiKey) {
        return res.status(400).json({
          success: false,
          message:
            "API Key is required."
        });
      }

      if (!clientId) {
        return res.status(400).json({
          success: false,
          message:
            "Client ID is required."
        });
      }

      if (!mpin) {
        return res.status(400).json({
          success: false,
          message:
            "MPIN is required."
        });
      }

      if (!totpSecret) {
        return res.status(400).json({
          success: false,
          message:
            "TOTP Secret is required."
        });
      }

      console.log(
        `Angel One login attempt for ${clientId}`
      );

      // ------------------------------------------------------
      // CREATE SMART API
      // ------------------------------------------------------

      const smartApi =
        new SmartAPI({
          api_key: apiKey
        });

      // ------------------------------------------------------
      // CLEAN TOTP SECRET
      // ------------------------------------------------------

      const cleanSecret =
        normalizeTotpSecret(
          totpSecret
        );

      if (!cleanSecret) {

        return res.status(400).json({
          success: false,
          message:
            "TOTP Secret is empty."
        });

      }

      console.log(
        "TOTP secret received."
      );

      // ------------------------------------------------------
      // GENERATE CURRENT 6 DIGIT TOTP
      // ------------------------------------------------------
      //
      // IMPORTANT:
      // otplib v13 uses:
      //
      // generate({ secret })
      //
      // and returns a Promise.
      //
      // ------------------------------------------------------

      let currentTotp;

      try {

        currentTotp =
          await generate({
            secret: cleanSecret
          });

      } catch (error) {

        console.error(
          "TOTP generation error:",
          error
        );

        return res.status(400).json({
          success: false,
          message:
            "TOTP Secret could not be converted to OTP. Please check the Secret."
        });
      }

      if (
        !currentTotp ||
        !/^\d{6}$/.test(
          String(currentTotp)
        )
      ) {

        return res.status(400).json({
          success: false,
          message:
            "Unable to generate 6-digit TOTP."
        });

      }

      console.log(
        "6-digit TOTP generated successfully."
      );

      // ------------------------------------------------------
      // ANGEL ONE LOGIN
      // ------------------------------------------------------

      const loginResponse =
        await smartApi.generateSession(
          clientId,
          mpin,
          currentTotp
        );

      if (
        !loginResponse ||
        loginResponse.status !== true
      ) {

        console.error(
          "Angel One login failed:",
          loginResponse
        );

        return res.status(401).json({

          success: false,

          message:
            loginResponse?.message ||
            loginResponse?.errorcode ||
            "Angel One login failed."

        });
      }

      const data =
        loginResponse.data || {};

      if (!data.jwtToken) {

        return res.status(401).json({
          success: false,
          message:
            "Angel One did not return JWT token."
        });

      }

      // ------------------------------------------------------
      // SAVE SESSION
      // ------------------------------------------------------

      currentSession = {

        apiKey,

        clientId,

        jwtToken:
          data.jwtToken,

        refreshToken:
          data.refreshToken ||
          null,

        feedToken:
          data.feedToken ||
          null,

        smartApi
      };

      console.log(
        "========================================"
      );

      console.log(
        "ANGEL ONE LOGIN SUCCESS"
      );

      console.log(
        "========================================"
      );

      // ------------------------------------------------------
      // CLEAR OLD DATA
      // ------------------------------------------------------

      priceData.clear();

      volumeData.clear();

      volumeHistory.clear();

      // ------------------------------------------------------
      // START LIVE CASH FEED
      // ------------------------------------------------------

      startCashWebSocket();

      return res.json({

        success: true,

        message:
          "Angel One connected successfully.",

        cashStocks:
          cashUniverse.length

      });

    } catch (error) {

      console.error(
        "LOGIN ERROR:",
        error
      );

      currentSession = null;

      return res.status(500).json({

        success: false,

        message:
          error.message ||
          "Angel One login failed."

      });
    }
  }
);

// ============================================================
// START CASH WEBSOCKET
// ============================================================

function startCashWebSocket() {

  if (!currentSession) {
    return;
  }

  if (cashWebSocket) {

    try {
      cashWebSocket.close();
    } catch (error) {}

  }

  cashWebSocket = null;

  websocketRunning = false;

  try {

    console.log(
      "Starting NSE Cash WebSocket..."
    );

    cashWebSocket =
      new WebSocketV2({

        jwttoken:
          currentSession.jwtToken,

        apikey:
          currentSession.apiKey,

        clientcode:
          currentSession.clientId,

        feedtype:
          currentSession.feedToken

      });

    cashWebSocket.on(
      "tick",
      handleCashTick
    );

    cashWebSocket
      .connect()
      .then(() => {

        websocketRunning =
          true;

        console.log(
          "NSE Cash WebSocket connected."
        );

        subscribeCashTokens();

      })
      .catch((error) => {

        websocketRunning =
          false;

        console.error(
          "WebSocket connection error:",
          error
        );

      });

  } catch (error) {

    websocketRunning =
      false;

    console.error(
      "WebSocket start error:",
      error
    );
  }
}

// ============================================================
// SUBSCRIBE CASH TOKENS
// ============================================================

function subscribeCashTokens() {

  if (
    !cashWebSocket ||
    !cashUniverse.length
  ) {
    return;
  }

  const tokens =
    cashUniverse.map(
      (stock) =>
        String(stock.cashToken)
    );

  const BATCH_SIZE = 100;

  let batchNumber = 0;

  for (
    let i = 0;
    i < tokens.length;
    i += BATCH_SIZE
  ) {

    const batch =
      tokens.slice(
        i,
        i + BATCH_SIZE
      );

    batchNumber++;

    const request = {

      correlationID:
        `cash_${Date.now()}_${batchNumber}`,

      action: 1,

      // Snap Quote
      mode: 3,

      // NSE Cash
      exchangeType: 1,

      tokens:
        batch

    };

    try {

      cashWebSocket.fetchData(
        request
      );

      console.log(
        `Cash batch ${batchNumber} subscribed: ${batch.length}`
      );

    } catch (error) {

      console.error(
        "Cash subscription error:",
        error
      );
    }
  }
}

// ============================================================
// HANDLE LIVE CASH TICK
// ============================================================

function handleCashTick(tick) {

  try {

    if (!tick) return;

    let data = tick;

    // --------------------------------------------------------
    // BUFFER
    // --------------------------------------------------------

    if (Buffer.isBuffer(data)) {

      try {

        data =
          JSON.parse(
            data.toString()
          );

      } catch (error) {

        return;
      }
    }

    // --------------------------------------------------------
    // STRING
    // --------------------------------------------------------

    if (
      typeof data === "string"
    ) {

      try {

        data =
          JSON.parse(data);

      } catch (error) {

        return;
      }
    }

    if (
      !data ||
      typeof data !== "object"
    ) {
      return;
    }

    // --------------------------------------------------------
    // TOKEN
    // --------------------------------------------------------

    const token =
      data.token ??
      data.symbolToken ??
      data.symboltoken;

    if (!token) return;

    const stock =
      cashByToken.get(
        String(token)
      );

    if (!stock) return;

    // --------------------------------------------------------
    // LTP
    // --------------------------------------------------------

    let ltp =
      numberValue(
        data.last_traded_price ??
        data.lastTradedPrice ??
        data.ltp
      );

    // Angel One price is in paise.
    if (ltp > 0) {
      ltp =
        ltp / 100;
    }

    // --------------------------------------------------------
    // VOLUME
    // --------------------------------------------------------

    const volume =
      numberValue(
        data.vol_traded ??
        data.volume_traded ??
        data.tradeVolume ??
        data.volume
      );

    // --------------------------------------------------------
    // NET CHANGE
    // --------------------------------------------------------

    let netChange =
      numberValue(
        data.net_change ??
        data.netChange ??
        data.change
      );

    if (
      Math.abs(netChange) > 10000
    ) {
      netChange =
        netChange / 100;
    }

    // --------------------------------------------------------
    // CHANGE %
    // --------------------------------------------------------

    let changePercent =
      numberValue(
        data.percent_change ??
        data.percentChange ??
        data.changePercent
      );

    // --------------------------------------------------------
    // PREVIOUS CLOSE
    // --------------------------------------------------------

    let close =
      numberValue(
        data.close_price ??
        data.close ??
        data.prev_close ??
        data.previousClose
      );

    if (close > 0) {
      close =
        close / 100;
    }

    // --------------------------------------------------------
    // FALLBACK CHANGE %
    // --------------------------------------------------------

    if (
      changePercent === 0 &&
      close > 0 &&
      ltp > 0
    ) {

      changePercent =
        ((ltp - close) /
          close) *
        100;

    }

    const now =
      Date.now();

    // --------------------------------------------------------
    // SAVE LIVE PRICE
    // --------------------------------------------------------

    priceData.set(
      stock.underlying,
      {

        symbol:
          stock.underlying,

        cashSymbol:
          stock.cashSymbol,

        token:
          stock.cashToken,

        price:
          ltp,

        change:
          netChange,

        changePercent,

        volume,

        updatedAt:
          now

      }
    );

    // --------------------------------------------------------
    // SAVE VOLUME
    // --------------------------------------------------------

    if (volume > 0) {

      volumeData.set(
        stock.underlying,
        {

          symbol:
            stock.underlying,

          cashSymbol:
            stock.cashSymbol,

          token:
            stock.cashToken,

          volume,

          price:
            ltp,

          changePercent,

          updatedAt:
            now

        }
      );

      if (
        !volumeHistory.has(
          stock.underlying
        )
      ) {

        volumeHistory.set(
          stock.underlying,
          []
        );

      }

      const history =
        volumeHistory.get(
          stock.underlying
        );

      const last =
        history[
          history.length - 1
        ];

      // Approximately 1 sample per second.
      if (
        !last ||
        now - last.time >= 1000
      ) {

        history.push({

          time:
            now,

          volume

        });

      }

      while (
        history.length >
        MAX_HISTORY_PER_STOCK
      ) {

        history.shift();

      }

      // Keep last 5 minutes.
      while (
        history.length &&
        now - history[0].time >
          5 * 60 * 1000
      ) {

        history.shift();

      }
    }

  } catch (error) {

    console.error(
      "Cash tick error:",
      error.message
    );
  }
}

// ============================================================
// OI GAINERS
// ============================================================

app.get(
  "/api/oi-gainers",
  async (req, res) => {

    try {

      if (
        !currentSession ||
        !currentSession.smartApi
      ) {

        return res.status(401).json({

          success: false,

          message:
            "Please login first."

        });
      }

      const result =
        await currentSession.smartApi.gainersLosers(
          {

            datatype:
              "PercOIGainers",

            expirytype:
              "NEAR"

          }
        );

      const rows =
        normalizeApiData(
          result
        );

      const output =
        rows
          .map((item) => {

            const symbol =
              getUnderlyingFromFutureSymbol(
                item.tradingSymbol
              );

            const live =
              priceData.get(
                symbol
              );

            return {

              symbol,

              oiPercent:
                percentValue(
                  item.percentChange
                ),

              openInterest:
                numberValue(
                  item.opnInterest
                ),

              netChangeOpenInterest:
                numberValue(
                  item.netChangeOpnInterest
                ),

              price:
                live?.price ??
                null,

              change:
                live?.change ??
                null,

              changePercent:
                live?.changePercent ??
                null,

              liveUpdatedAt:
                live?.updatedAt ??
                null

            };

          })

          .filter(
            (item) =>
              item.symbol
          )

          // HIGHEST OI GAIN FIRST
          .sort(
            (a, b) =>
              b.oiPercent -
              a.oiPercent
          )

          .slice(
            0,
            10
          );

      res.json({

        success: true,

        data:
          output,

        updatedAt:
          Date.now()

      });

    } catch (error) {

      console.error(
        "OI GAINERS ERROR:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          error.message ||
          "Unable to load OI Gainers."

      });
    }
  }
);

// ============================================================
// OI LOSERS
// ============================================================

app.get(
  "/api/oi-losers",
  async (req, res) => {

    try {

      if (
        !currentSession ||
        !currentSession.smartApi
      ) {

        return res.status(401).json({

          success: false,

          message:
            "Please login first."

        });
      }

      const result =
        await currentSession.smartApi.gainersLosers(
          {

            datatype:
              "PercOILosers",

            expirytype:
              "NEAR"

          }
        );

      const rows =
        normalizeApiData(
          result
        );

      const output =
        rows
          .map((item) => {

            const symbol =
              getUnderlyingFromFutureSymbol(
                item.tradingSymbol
              );

            const live =
              priceData.get(
                symbol
              );

            return {

              symbol,

              oiPercent:
                percentValue(
                  item.percentChange
                ),

              openInterest:
                numberValue(
                  item.opnInterest
                ),

              netChangeOpenInterest:
                numberValue(
                  item.netChangeOpnInterest
                ),

              price:
                live?.price ??
                null,

              change:
                live?.change ??
                null,

              changePercent:
                live?.changePercent ??
                null,

              liveUpdatedAt:
                live?.updatedAt ??
                null

            };

          })

          .filter(
            (item) =>
              item.symbol
          )

          // MOST NEGATIVE FIRST
          .sort(
            (a, b) =>
              a.oiPercent -
              b.oiPercent
          )

          .slice(
            0,
            10
          );

      res.json({

        success: true,

        data:
          output,

        updatedAt:
          Date.now()

      });

    } catch (error) {

      console.error(
        "OI LOSERS ERROR:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          error.message ||
          "Unable to load OI Losers."

      });
    }
  }
);

// ============================================================
// OLD VOLUME
// ============================================================

function getOldVolume(symbol) {

  const history =
    volumeHistory.get(
      symbol
    );

  if (
    !history ||
    history.length < 2
  ) {
    return null;
  }

  const now =
    Date.now();

  const targetTime =
    now -
    VOLUME_LOOKBACK_MS;

  let candidate =
    history[0];

  for (
    const item of history
  ) {

    if (
      item.time <=
      targetTime
    ) {

      candidate =
        item;

    }
  }

  return candidate;
}

// ============================================================
// VOLUME GAINERS
// ============================================================

function getVolumeGainers() {

  const results = [];

  for (
    const [
      symbol,
      current
    ] of volumeData.entries()
  ) {

    if (
      !current ||
      current.volume <= 0
    ) {
      continue;
    }

    const old =
      getOldVolume(
        symbol
      );

    if (!old) {
      continue;
    }

    const increase =
      current.volume -
      old.volume;

    if (increase <= 0) {
      continue;
    }

    const percent =
      old.volume > 0
        ? (
            increase /
            old.volume
          ) * 100
        : 0;

    results.push({

      symbol,

      price:
        current.price,

      changePercent:
        current.changePercent,

      currentVolume:
        current.volume,

      previousVolume:
        old.volume,

      volumeIncrease:
        increase,

      volumePercent:
        percent,

      updatedAt:
        current.updatedAt

    });
  }

  results.sort(
    (a, b) =>
      b.volumePercent -
      a.volumePercent
  );

  return results.slice(
    0,
    10
  );
}

// ============================================================
// VOLUME API
// ============================================================

app.get(
  "/api/volume-gainers",
  (req, res) => {

    try {

      const data =
        getVolumeGainers();

      res.json({

        success: true,

        data,

        intervalSeconds:
          VOLUME_LOOKBACK_MS /
          1000,

        collecting:
          data.length === 0,

        liveStocks:
          priceData.size,

        historyStocks:
          volumeHistory.size,

        websocketRunning,

        updatedAt:
          Date.now()

      });

    } catch (error) {

      console.error(
        "VOLUME ERROR:",
        error
      );

      res.status(500).json({

        success: false,

        message:
          error.message ||
          "Unable to calculate volume gainers."

      });
    }
  }
);

// ============================================================
// STATUS
// ============================================================

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      success: true,

      loggedIn:
        !!currentSession,

      websocketRunning,

      fnoStocks:
        fnoUniverse.length,

      liveCashStocks:
        priceData.size,

      historyStocks:
        volumeHistory.size,

      updatedAt:
        Date.now()

    });
  }
);

// ============================================================
// LOGOUT
// ============================================================

app.post(
  "/api/logout",
  (req, res) => {

    try {

      if (cashWebSocket) {

        try {
          cashWebSocket.close();
        } catch (error) {}

      }

      cashWebSocket = null;

      websocketRunning =
        false;

      currentSession =
        null;

      priceData.clear();

      volumeData.clear();

      volumeHistory.clear();

      res.json({

        success: true,

        message:
          "Logged out successfully."

      });

    } catch (error) {

      res.status(500).json({

        success: false,

        message:
          error.message

      });
    }
  }
);

// ============================================================
// FRONTEND FALLBACK
// ============================================================

app.get(
  "/{*splat}",
  (req, res) => {

    res.sendFile(
      require("path").join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

// ============================================================
// START SERVER
// ============================================================

async function startServer() {

  try {

    await buildUniverse();

    app.listen(
      PORT,
      () => {

        console.log(
          `F&O Live Scanner running on port ${PORT}`
        );

      }
    );

  } catch (error) {

    console.error(
      "Scrip master loading failed:",
      error
    );

    // Still start Express.
    app.listen(
      PORT,
      () => {

        console.log(
          `Server running on port ${PORT}`
        );

      }
    );
  }
}

startServer();
