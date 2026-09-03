const express = require("express");
const cors = require("cors");
const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");
const { generate } = require("otplib");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

let smartApi = null;
let webSocket = null;
let sessionData = null;

let cashUniverse = [];
let priceData = {};
let volumeData = {};

let lastTickTime = null;
let wsConnected = false;


// ==================================================
// TOTP SECRET CLEANER
// ==================================================

function normalizeTotpSecret(input) {
  if (!input) return "";

  let secret = String(input).trim();

  // Agar galti se otpauth URI paste ki ho
  if (secret.toLowerCase().startsWith("otpauth://")) {
    try {
      const url = new URL(secret);
      const uriSecret = url.searchParams.get("secret");

      if (uriSecret) {
        secret = uriSecret;
      }
    } catch (error) {
      console.log("TOTP URI parse failed, using entered value.");
    }
  }

  // Agar "secret=XXXX" format me ho
  const match = secret.match(
    /(?:^|[?&\s])secret=([A-Za-z0-9=]+)/i
  );

  if (match && match[1]) {
    secret = match[1];
  }

  // Spaces / hyphens remove
  secret = secret
    .replace(/\s+/g, "")
    .replace(/-/g, "")
    .toUpperCase();

  return secret;
}


// ==================================================
// BUILD F&O ELIGIBLE NSE CASH UNIVERSE
// ==================================================

async function buildCashUniverse() {
  try {
    console.log("Downloading Angel One scrip master...");

    const response = await fetch(
      "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json"
    );

    if (!response.ok) {
      throw new Error("Unable to download Angel One scrip master.");
    }

    const master = await response.json();

    const fnoStocks = new Set();

    // ----------------------------------------------
    // F&O STOCK FUTURES
    // ----------------------------------------------

    for (const item of master) {
      if (
        item.exch_seg === "NFO" &&
        item.instrumenttype === "FUTSTK" &&
        item.name
      ) {
        fnoStocks.add(
          cleanSymbol(item.name)
        );
      }
    }

    // ----------------------------------------------
    // NSE CASH EQUITY
    // ----------------------------------------------

    const cashMap = new Map();

    for (const item of master) {
      if (
        item.exch_seg === "NSE" &&
        item.symbol &&
        item.symbol.endsWith("-EQ") &&
        item.token
      ) {
        const symbol = cleanSymbol(item.symbol);

        if (fnoStocks.has(symbol)) {
          cashMap.set(symbol, {
            symbol,
            token: String(item.token),
            tradingSymbol: item.symbol,
            exchange: "NSE"
          });
        }
      }
    }

    cashUniverse = Array.from(cashMap.values());

    console.log(
      `F&O eligible NSE cash stocks loaded: ${cashUniverse.length}`
    );

    return cashUniverse;

  } catch (error) {
    console.error(
      "Cash universe error:",
      error.message
    );

    cashUniverse = [];

    return [];
  }
}


// ==================================================
// SYMBOL CLEANER
// ==================================================

function cleanSymbol(symbol) {
  if (!symbol) return "";

  return String(symbol)
    .replace(/-EQ$/i, "")
    .replace(/FUT$/i, "")
    .trim()
    .toUpperCase();
}


// ==================================================
// ANGEL ONE LOGIN
// ==================================================

app.post("/api/login", async (req, res) => {
  try {

    const {
      apiKey,
      clientId,
      mpin,
      totpSecret
    } = req.body;


    // ----------------------------------------------
    // BASIC VALIDATION
    // ----------------------------------------------

    if (
      !apiKey ||
      !clientId ||
      !mpin ||
      !totpSecret
    ) {
      return res.status(400).json({
        success: false,
        message:
          "API Key, Client ID, MPIN aur TOTP Secret required hai."
      });
    }


    // ----------------------------------------------
    // LONG TOTP SECRET
    // ----------------------------------------------

    const cleanSecret =
      normalizeTotpSecret(totpSecret);


    if (!cleanSecret) {
      return res.status(400).json({
        success: false,
        message:
          "TOTP Secret empty hai."
      });
    }


    // Important:
    // Yahan 6 digit TOTP nahi chahiye.
    // Yahan LONG alphanumeric SECRET chahiye.

    console.log(
      `TOTP Secret received. Length: ${cleanSecret.length}`
    );


    // ----------------------------------------------
    // GENERATE CURRENT 6 DIGIT TOTP
    // ----------------------------------------------

    let currentTotp;

    try {

      currentTotp = await generate({
        secret: cleanSecret
      });

    } catch (totpError) {

      console.error(
        "TOTP generation error:",
        totpError
      );

      return res.status(400).json({
        success: false,
        message:
          "TOTP Secret se code generate nahi ho pa raha. Angel One ka generated TOTP Secret exactly paste karein."
      });
    }


    console.log(
      "Current TOTP generated successfully."
    );


    // ----------------------------------------------
    // SMART API INITIALIZE
    // ----------------------------------------------

    smartApi = new SmartAPI({
      api_key: apiKey.trim()
    });


    // ----------------------------------------------
    // ANGEL ONE SESSION
    // ----------------------------------------------

    const data =
      await smartApi.generateSession(
        clientId.trim(),
        mpin.trim(),
        currentTotp
      );


    console.log(
      "Angel One login response received."
    );


    if (
      !data ||
      !data.status ||
      !data.data
    ) {

      console.error(
        "Angel One login failed:",
        data
      );

      return res.status(401).json({
        success: false,
        message:
          data?.message ||
          data?.errorcode ||
          "Angel One login failed. Credentials ya TOTP Secret check karein."
      });
    }


    // ----------------------------------------------
    // SESSION SAVE
    // ----------------------------------------------

    sessionData = data.data;


    const jwtToken =
      data.data.jwtToken;


    // ----------------------------------------------
    // FEED TOKEN
    // ----------------------------------------------

    let feedToken =
      data.data.feedToken;


    if (!feedToken) {
      try {
        feedToken =
          smartApi.getfeedToken();
      } catch (error) {
        console.log(
          "Feed token unavailable:",
          error.message
        );
      }
    }


    sessionData.feedToken =
      feedToken;


    console.log(
      "================================"
    );

    console.log(
      "ANGEL ONE LOGIN SUCCESSFUL"
    );

    console.log(
      `Client ID: ${clientId.trim()}`
    );

    console.log(
      "================================"
    );


    // ----------------------------------------------
    // BUILD CASH UNIVERSE
    // ----------------------------------------------

    await buildCashUniverse();


    // ----------------------------------------------
    // START LIVE CASH WEBSOCKET
    // ----------------------------------------------

    if (
      jwtToken &&
      feedToken
    ) {

      startCashWebSocket({
        jwtToken,
        feedToken,
        apiKey: apiKey.trim(),
        clientId: clientId.trim()
      });

    } else {

      console.log(
        "JWT / FeedToken missing. WebSocket not started."
      );
    }


    return res.json({
      success: true,

      message:
        "Angel One connected successfully.",

      stocks:
        cashUniverse.length,

      websocket:
        Boolean(jwtToken && feedToken)
    });


  } catch (error) {

    console.error(
      "LOGIN ERROR:",
      error
    );

    return res.status(401).json({
      success: false,

      message:
        error?.message ||
        "Angel One login failed."
    });
  }
});


// ==================================================
// LIVE NSE CASH WEBSOCKET
// ==================================================

function startCashWebSocket({
  jwtToken,
  feedToken,
  apiKey,
  clientId
}) {

  try {

    // ----------------------------------------------
    // OLD CONNECTION CLOSE
    // ----------------------------------------------

    if (webSocket) {

      try {
        webSocket.close();
      } catch (e) {}

      webSocket = null;
    }


    console.log(
      "Starting NSE Cash WebSocket..."
    );


    // ----------------------------------------------
    // WEBSOCKET V2
    // ----------------------------------------------

    webSocket =
      new WebSocketV2({

        jwttoken:
          jwtToken,

        apikey:
          apiKey,

        clientcode:
          clientId,

        feedtype:
          feedToken
      });


    // ----------------------------------------------
    // CONNECT
    // ----------------------------------------------

    webSocket.connect()
      .then(() => {

        wsConnected = true;

        console.log(
          "NSE Cash WebSocket connected."
        );


        const tokens =
          cashUniverse.map(
            stock => stock.token
          );


        if (!tokens.length) {

          console.log(
            "No NSE cash tokens available."
          );

          return;
        }


        // ------------------------------------------
        // SNAP QUOTE
        //
        // mode 3 = Snap Quote
        // exchangeType 1 = NSE Cash
        // ------------------------------------------

        const request = {

          correlationID:
            "fno-live-scanner",

          action: 1,

          mode: 3,

          exchangeType: 1,

          tokens
        };


        console.log(
          `Subscribing to ${tokens.length} NSE cash stocks...`
        );


        webSocket.fetchData(
          request
        );


        // ------------------------------------------
        // TICK
        // ------------------------------------------

        webSocket.on(
          "tick",
          handleCashTick
        );


        webSocket.on(
          "error",
          error => {

            console.error(
              "WebSocket error:",
              error
            );

            wsConnected = false;
          }
        );


        webSocket.on(
          "close",
          () => {

            console.log(
              "WebSocket closed."
            );

            wsConnected = false;
          }
        );

      })
      .catch(error => {

        console.error(
          "WebSocket connection failed:",
          error
        );

        wsConnected = false;
      });


  } catch (error) {

    console.error(
      "WebSocket start error:",
      error
    );

    wsConnected = false;
  }
}


// ==================================================
// HANDLE CASH MARKET TICK
// ==================================================

function handleCashTick(tick) {

  try {

    if (!tick) return;


    const token =
      String(
        tick.token ||
        tick.symbolToken ||
        tick.symboltoken ||
        ""
      );


    if (!token) return;


    const stock =
      cashUniverse.find(
        item =>
          item.token === token
      );


    if (!stock) return;


    // ----------------------------------------------
    // PRICE
    // ----------------------------------------------

    let ltp =
      Number(
        tick.last_traded_price ??
        tick.lastTradedPrice ??
        tick.ltp ??
        0
      );


    // ----------------------------------------------
    // VOLUME
    // ----------------------------------------------

    const volume =
      Number(
        tick.vol_traded ??
        tick.volumeTraded ??
        tick.volume ??
        0
      );


    // Angel One raw price can be paise based.
    if (ltp > 100000) {
      ltp = ltp / 100;
    }


    // ----------------------------------------------
    // STORE PRICE
    // ----------------------------------------------

    if (ltp > 0) {

      priceData[
        stock.symbol
      ] = {

        price: ltp,

        timestamp:
          Date.now()
      };
    }


    // ----------------------------------------------
    // STORE VOLUME
    // ----------------------------------------------

    if (volume >= 0) {

      volumeData[
        stock.symbol
      ] = {

        volume,

        timestamp:
          Date.now()
      };
    }


    lastTickTime =
      Date.now();


  } catch (error) {

    console.error(
      "Tick processing error:",
      error.message
    );
  }
}


// ==================================================
// OI GAINERS / LOSERS
// ==================================================

async function getOIMovers(type) {

  if (!smartApi) {
    throw new Error(
      "Angel One is not connected."
    );
  }


  const datatype =
    type === "gainers"
      ? "PercOIGainers"
      : "PercOILosers";


  const response =
    await smartApi.gainersLosers({

      datatype,

      expirytype:
        "NEAR"
    });


  if (
    !response ||
    !response.status
  ) {

    throw new Error(
      response?.message ||
      "Unable to fetch OI movers."
    );
  }


  const rows =
    Array.isArray(response.data)
      ? response.data
      : [];


  return rows
    .map(item => {

      const tradingSymbol =
        item.tradingSymbol ||
        "";


      const baseSymbol =
        cleanSymbol(
          tradingSymbol
        );


      const live =
        priceData[
          baseSymbol
        ];


      return {

        symbol:
          baseSymbol,

        price:
          live?.price ||
          null,

        changePercent:
          Number(
            item.percentChange ||
            0
          ),

        oiPercent:
          Number(
            item.percentChange ||
            0
          ),

        oi:
          Number(
            item.opnInterest ||
            0
          ),

        oiChange:
          Number(
            item.netChangeOpnInterest ||
            0
          ),

        token:
          item.symbolToken ||
          null
      };

    })
    .filter(
      item =>
        item.symbol
    );
}


// ==================================================
// VOLUME GAINERS
// ==================================================

function getVolumeGainers() {

  const now =
    Date.now();


  const rows =
    Object.entries(
      volumeData
    )

    .map(
      ([symbol, data]) => {

        const live =
          priceData[symbol];


        return {

          symbol,

          volume:
            Number(
              data.volume ||
              0
            ),

          price:
            live?.price ||
            null,

          age:
            now -
            data.timestamp
        };
      }
    )

    .filter(
      item =>
        item.volume > 0
    )

    // 2 minute se purana tick remove
    .filter(
      item =>
        item.age < 120000
    );


  // Highest NSE cash volume first
  rows.sort(
    (a, b) =>
      b.volume -
      a.volume
  );


  return rows.slice(
    0,
    10
  );
}


// ==================================================
// SCANNER API
// ==================================================

app.get(
  "/api/scanner",
  async (req, res) => {

    try {

      if (
        !smartApi ||
        !sessionData
      ) {

        return res.status(401).json({

          success: false,

          message:
            "Please connect Angel One first."
        });
      }


      const [
        gainers,
        losers
      ] =
        await Promise.all([

          getOIMovers(
            "gainers"
          ),

          getOIMovers(
            "losers"
          )
        ]);


      const volumeGainers =
        getVolumeGainers();


      // --------------------------------------------
      // SORT
      // --------------------------------------------

      gainers.sort(
        (a, b) =>
          b.oiPercent -
          a.oiPercent
      );


      losers.sort(
        (a, b) =>
          a.oiPercent -
          b.oiPercent
      );


      return res.json({

        success: true,

        oiGainers:
          gainers.slice(
            0,
            10
          ),

        oiLosers:
          losers.slice(
            0,
            10
          ),

        volumeGainers,

        status: {

          stocks:
            cashUniverse.length,

          liveStocks:
            Object.keys(
              priceData
            ).length,

          volumeStocks:
            Object.keys(
              volumeData
            ).length,

          websocket:
            wsConnected,

          lastTickTime
        }
      });


    } catch (error) {

      console.error(
        "Scanner error:",
        error
      );


      return res.status(500).json({

        success: false,

        message:
          error?.message ||
          "Scanner data error."
      });
    }
  }
);


// ==================================================
// STATUS
// ==================================================

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      connected:
        Boolean(
          smartApi &&
          sessionData
        ),

      websocket:
        wsConnected,

      stocks:
        cashUniverse.length,

      liveStocks:
        Object.keys(
          priceData
        ).length,

      volumeStocks:
        Object.keys(
          volumeData
        ).length,

      lastTickTime
    });
  }
);


// ==================================================
// LOGOUT
// ==================================================

app.post(
  "/api/logout",
  (req, res) => {

    try {

      if (webSocket) {

        try {
          webSocket.close();
        } catch (e) {}

      }


      webSocket = null;

      smartApi = null;

      sessionData = null;

      cashUniverse = [];

      priceData = {};

      volumeData = {};

      wsConnected = false;

      lastTickTime = null;


      res.json({

        success: true,

        message:
          "Logged out."
      });


    } catch (error) {

      res.json({
        success: true
      });
    }
  }
);


// ==================================================
// FRONTEND FALLBACK - EXPRESS 5
// ==================================================

app.get(
  "/{*splat}",
  (req, res) => {

    res.sendFile(
      __dirname +
      "/public/index.html"
    );
  }
);


// ==================================================
// START SERVER
// ==================================================

app.listen(
  PORT,
  () => {

    console.log(
      `F&O Live Scanner running on port ${PORT}`
    );
  }
);
