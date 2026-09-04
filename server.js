const express = require("express");
const cors = require("cors");

const {
  SmartAPI,
  WebSocketV2
} = require("smartapi-javascript");

const {
  generate
} = require("otplib");

const app = express();

const PORT =
  process.env.PORT || 10000;

app.use(cors());

app.use(express.json());

app.use(express.static("public"));


// =====================================================
// STATE
// =====================================================

let smartApi = null;
let sessionData = null;
let webSocket = null;

let websocketReady = false;

let fnoCashUniverse = [];

let cashByToken = new Map();


// FUTURE TOKEN -> CASH SYMBOL
let futureTokenToCash = new Map();


// FUTURE TRADING SYMBOL -> CASH SYMBOL
let futureSymbolToCash = new Map();


let priceData = {};

let oiGainers = [];
let oiLosers = [];

let oiRefreshTimer = null;


// =====================================================
// INDEXES
// =====================================================

const indexState = {
  nifty: false,
  sensex: false
};


const indexData = {

  nifty: {
    name: "NIFTY 50",
    exchangeType: 1,
    token: "99926000",
    price: null,
    close: null,
    change: null,
    changePercent: null,
    timestamp: null
  },

  sensex: {
    name: "SENSEX",
    exchangeType: 3,
    token: "99919000",
    price: null,
    close: null,
    change: null,
    changePercent: null,
    timestamp: null
  }

};


// =====================================================
// SSE
// =====================================================

const clients = new Set();


// =====================================================
// ACTIVITY LOG
// =====================================================

let activityLogs = [];


function addLog(
  message,
  type = "INFO"
) {

  const log = {

    time:
      new Date().toISOString(),

    type,

    message
  };


  activityLogs.push(log);


  if (
    activityLogs.length > 300
  ) {

    activityLogs =
      activityLogs.slice(-300);
  }


  console.log(
    `[${type}] ${message}`
  );


  broadcast(
    "activity",
    log
  );
}


// =====================================================
// BROADCAST
// =====================================================

function broadcast(
  event,
  data
) {

  const packet =
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;


  for (
    const client of clients
  ) {

    try {

      client.write(packet);

    } catch (error) {

      clients.delete(
        client
      );
    }
  }
}


// =====================================================
// TOTP SECRET
// =====================================================

function normalizeTotpSecret(
  input
) {

  if (!input) {

    return "";
  }


  let secret =
    String(input).trim();


  if (
    secret
      .toLowerCase()
      .startsWith("otpauth://")
  ) {

    try {

      const url =
        new URL(secret);

      const value =
        url.searchParams.get(
          "secret"
        );

      if (value) {

        secret = value;
      }

    } catch (error) {

      addLog(
        "Could not parse otpauth URI. Using entered secret.",
        "WARN"
      );
    }
  }


  const match =
    secret.match(
      /(?:^|[?&\s])secret=([A-Za-z0-9=]+)/i
    );


  if (
    match &&
    match[1]
  ) {

    secret =
      match[1];
  }


  return secret
    .replace(/\s+/g, "")
    .replace(/-/g, "")
    .toUpperCase();
}


// =====================================================
// CLEAN CASH SYMBOL
// =====================================================

function cleanSymbol(
  value
) {

  if (!value) {

    return "";
  }


  return String(value)
    .replace(
      /-EQ$/i,
      ""
    )
    .trim()
    .toUpperCase();
}


// =====================================================
// BUILD UNIVERSE
// =====================================================

async function buildUniverse() {

  addLog(
    "Downloading Angel One instrument master..."
  );


  const response =
    await fetch(
      "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json"
    );


  if (!response.ok) {

    throw new Error(
      "Angel One instrument master download failed."
    );
  }


  const master =
    await response.json();


  if (
    !Array.isArray(master)
  ) {

    throw new Error(
      "Invalid instrument master."
    );
  }


  // ---------------------------------------------------
  // STEP 1
  // F&O STOCK FUTURES
  // ---------------------------------------------------

  const fnoNames =
    new Set();


  const futures = [];


  for (
    const item of master
  ) {

    if (
      item.exch_seg === "NFO" &&
      item.instrumenttype === "FUTSTK" &&
      item.name &&
      item.token
    ) {

      const cashSymbol =
        cleanSymbol(
          item.name
        );


      if (!cashSymbol) {

        continue;
      }


      fnoNames.add(
        cashSymbol
      );


      futures.push({

        token:
          String(
            item.token
          ),

        tradingSymbol:
          String(
            item.symbol ||
            item.tradingsymbol ||
            ""
          ).toUpperCase(),

        name:
          cashSymbol
      });
    }
  }


  // ---------------------------------------------------
  // STEP 2
  // NSE CASH
  // ---------------------------------------------------

  const cashMap =
    new Map();


  for (
    const item of master
  ) {

    if (
      item.exch_seg === "NSE" &&
      item.symbol &&
      item.symbol.endsWith("-EQ") &&
      item.token
    ) {

      const symbol =
        cleanSymbol(
          item.symbol
        );


      if (
        fnoNames.has(
          symbol
        )
      ) {

        cashMap.set(
          symbol,
          {

            symbol,

            token:
              String(
                item.token
              ),

            tradingSymbol:
              item.symbol,

            exchangeType:
              1

          }
        );
      }
    }
  }


  fnoCashUniverse =
    Array.from(
      cashMap.values()
    );


  cashByToken =
    new Map();


  for (
    const cash of
    fnoCashUniverse
  ) {

    cashByToken.set(
      cash.token,
      cash
    );
  }


  // ---------------------------------------------------
  // STEP 3
  // DIRECT FUTURE TOKEN MAPPING
  // ---------------------------------------------------

  futureTokenToCash =
    new Map();


  futureSymbolToCash =
    new Map();


  for (
    const future of futures
  ) {

    if (
      cashMap.has(
        future.name
      )
    ) {

      futureTokenToCash.set(
        future.token,
        future.name
      );


      if (
        future.tradingSymbol
      ) {

        futureSymbolToCash.set(
          future.tradingSymbol,
          future.name
        );
      }
    }
  }


  addLog(
    `F&O cash universe ready: ${fnoCashUniverse.length} stocks.`,
    "SUCCESS"
  );


  addLog(
    `Direct futures-to-cash mapping ready: ${futureTokenToCash.size} contracts.`,
    "SUCCESS"
  );
}


// =====================================================
// FUTURE -> CASH SYMBOL
// =====================================================

function getCashSymbolFromOI(
  item
) {

  // -----------------------------------------------
  // 1. symbolToken direct mapping
  // -----------------------------------------------

  const token =
    String(
      item?.symbolToken ||
      item?.token ||
      ""
    );


  if (
    token &&
    futureTokenToCash.has(
      token
    )
  ) {

    return futureTokenToCash.get(
      token
    );
  }


  // -----------------------------------------------
  // 2. tradingSymbol direct mapping
  // -----------------------------------------------

  const tradingSymbol =
    String(
      item?.tradingSymbol ||
      item?.symbol ||
      ""
    ).toUpperCase();


  if (
    tradingSymbol &&
    futureSymbolToCash.has(
      tradingSymbol
    )
  ) {

    return futureSymbolToCash.get(
      tradingSymbol
    );
  }


  // -----------------------------------------------
  // 3. fallback by cash universe prefix
  // -----------------------------------------------

  const symbols =
    Array.from(
      cashByToken.values()
    )
      .map(
        x => x.symbol
      )
      .sort(
        (a, b) =>
          b.length -
          a.length
      );


  for (
    const symbol of symbols
  ) {

    if (
      tradingSymbol.startsWith(
        symbol
      ) &&
      tradingSymbol.endsWith(
        "FUT"
      )
    ) {

      return symbol;
    }
  }


  return "";
}


// =====================================================
// LOGIN
// =====================================================

app.post(
  "/api/login",
  async (
    req,
    res
  ) => {

    try {

      const {
        apiKey,
        clientId,
        mpin,
        totpSecret
      } = req.body;


      if (
        !apiKey ||
        !clientId ||
        !mpin ||
        !totpSecret
      ) {

        return res
          .status(400)
          .json({

            success: false,

            message:
              "API Key, Client ID, MPIN aur Long TOTP Secret required hai."
          });
      }


      addLog(
        `Login started for ${String(clientId).trim()}.`
      );


      const secret =
        normalizeTotpSecret(
          totpSecret
        );


      if (!secret) {

        throw new Error(
          "TOTP Secret empty hai."
        );
      }


      addLog(
        `TOTP Secret received (${secret.length} characters).`
      );


      // ----------------------------------------------
      // AUTOMATIC CURRENT TOTP
      // ----------------------------------------------

      const currentTotp =
        await generate({
          secret
        });


      addLog(
        "Current 6-digit TOTP generated.",
        "SUCCESS"
      );


      // ----------------------------------------------
      // SMART API
      // ----------------------------------------------

      smartApi =
        new SmartAPI({

          api_key:
            String(
              apiKey
            ).trim()

        });


      const loginResponse =
        await smartApi.generateSession(

          String(
            clientId
          ).trim(),

          String(
            mpin
          ).trim(),

          currentTotp
        );


      if (
        !loginResponse ||
        !loginResponse.status ||
        !loginResponse.data
      ) {

        throw new Error(
          loginResponse?.message ||
          loginResponse?.errorcode ||
          "Angel One login failed."
        );
      }


      sessionData =
        loginResponse.data;


      let feedToken =
        sessionData.feedToken;


      if (!feedToken) {

        try {

          feedToken =
            await Promise.resolve(
              smartApi.getfeedToken()
            );

        } catch (error) {

          addLog(
            "Feed token could not be obtained.",
            "ERROR"
          );
        }
      }


      sessionData.feedToken =
        feedToken;


      addLog(
        "Angel One broker login successful.",
        "SUCCESS"
      );


      // ----------------------------------------------
      // BUILD SYMBOL UNIVERSE
      // ----------------------------------------------

      await buildUniverse();


      // ----------------------------------------------
      // START WS
      // ----------------------------------------------

      await startWebSocket({

        jwtToken:
          sessionData.jwtToken,

        feedToken,

        apiKey:
          String(
            apiKey
          ).trim(),

        clientId:
          String(
            clientId
          ).trim()

      });


      // ----------------------------------------------
      // FIRST OI LOAD
      // ----------------------------------------------

      await refreshOI();


      if (oiRefreshTimer) {

        clearInterval(
          oiRefreshTimer
        );
      }


      // Both gainers and losers
      // refresh in SAME Promise.all cycle.

      oiRefreshTimer =
        setInterval(
          async () => {

            try {

              await refreshOI();

            } catch (error) {

              addLog(
                `OI refresh error: ${error.message}`,
                "ERROR"
              );
            }

          },
          5000
        );


      broadcast(
        "login",
        {
          connected: true
        }
      );


      return res.json({

        success: true,

        message:
          "Angel One connected successfully.",

        stocks:
          fnoCashUniverse.length,

        websocket:
          websocketReady

      });


    } catch (error) {

      addLog(
        `Login failed: ${error.message}`,
        "ERROR"
      );


      return res
        .status(401)
        .json({

          success: false,

          message:
            error.message ||
            "Angel One login failed."
        });
    }
  }
);


// =====================================================
// WEBSOCKET
// =====================================================

async function startWebSocket(
  credentials
) {

  const {
    jwtToken,
    feedToken,
    apiKey,
    clientId
  } = credentials;


  if (
    !jwtToken ||
    !feedToken
  ) {

    throw new Error(
      "JWT token ya Feed Token missing hai."
    );
  }


  if (webSocket) {

    try {

      webSocket.close();

    } catch (error) {}

    webSocket =
      null;
  }


  addLog(
    "Starting SmartAPI WebSocket V2..."
  );


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


  return new Promise(
    (
      resolve,
      reject
    ) => {

      let finished =
        false;


      webSocket
        .connect()
        .then(
          () => {

            websocketReady =
              true;


            addLog(
              "SmartAPI WebSocket connected.",
              "SUCCESS"
            );


            webSocket.on(
              "tick",
              handleTick
            );


            webSocket.on(
              "error",
              error => {

                websocketReady =
                  false;


                addLog(
                  `WebSocket error: ${error?.message || error}`,
                  "ERROR"
                );


                broadcast(
                  "status",
                  getStatus()
                );
              }
            );


            webSocket.on(
              "close",
              () => {

                websocketReady =
                  false;


                addLog(
                  "WebSocket closed.",
                  "WARN"
                );


                broadcast(
                  "status",
                  getStatus()
                );
              }
            );


            // ----------------------------------------
            // SUBSCRIBE F&O CASH STOCKS
            // ----------------------------------------

            subscribeCashStocks();


            if (!finished) {

              finished =
                true;

              resolve();
            }

          }
        )
        .catch(
          error => {

            websocketReady =
              false;


            addLog(
              `WebSocket connection failed: ${error.message}`,
              "ERROR"
            );


            if (!finished) {

              finished =
                true;

              reject(error);
            }
          }
        );
    }
  );
}


// =====================================================
// SUBSCRIBE CASH STOCKS
// =====================================================

function subscribeCashStocks() {

  if (
    !webSocket ||
    !websocketReady
  ) {

    return;
  }


  const tokens =
    fnoCashUniverse.map(
      x => x.token
    );


  // Quote mode gives live price
  // and quote information.

  const chunkSize =
    100;


  for (
    let i = 0;
    i < tokens.length;
    i += chunkSize
  ) {

    const chunk =
      tokens.slice(
        i,
        i + chunkSize
      );


    webSocket.fetchData({

      correlationID:
        `cash-${i}`,

      action:
        1,

      mode:
        2,

      exchangeType:
        1,

      tokens:
        chunk

    });
  }


  addLog(
    `Subscribed ${tokens.length} F&O cash stocks for live ticks.`,
    "SUCCESS"
  );
}


// =====================================================
// INDEX TOGGLE
// =====================================================

app.post(
  "/api/index-toggle",
  (
    req,
    res
  ) => {

    try {

      const {
        index,
        enabled
      } = req.body;


      if (
        index !== "nifty" &&
        index !== "sensex"
      ) {

        return res
          .status(400)
          .json({

            success: false,

            message:
              "Invalid index."
          });
      }


      if (
        !webSocket ||
        !websocketReady
      ) {

        throw new Error(
          "Live WebSocket is not connected."
        );
      }


      const item =
        indexData[index];


      webSocket.fetchData({

        correlationID:
          `${index}-toggle`,

        action:
          enabled ? 1 : 0,

        mode:
          1,

        exchangeType:
          item.exchangeType,

        tokens:
          [
            item.token
          ]

      });


      indexState[index] =
        Boolean(enabled);


      addLog(
        `${item.name} tick-by-tick ${enabled ? "ON" : "OFF"}.`,
        enabled
          ? "SUCCESS"
          : "INFO"
      );


      broadcast(
        "indexState",
        indexState
      );


      res.json({

        success: true,

        indexState
      });


    } catch (error) {

      addLog(
        `Index toggle failed: ${error.message}`,
        "ERROR"
      );


      res
        .status(500)
        .json({

          success: false,

          message:
            error.message
        });
    }
  }
);


// =====================================================
// HANDLE TICK
// =====================================================

function handleTick(
  tick
) {

  try {

    if (!tick) {

      return;
    }


    const token =
      String(
        tick.token ||
        tick.symbolToken ||
        tick.symboltoken ||
        ""
      );


    if (!token) {

      return;
    }


    // -----------------------------------------------
    // NIFTY
    // -----------------------------------------------

    if (
      token ===
      indexData.nifty.token
    ) {

      updateIndex(
        "nifty",
        tick
      );

      return;
    }


    // -----------------------------------------------
    // SENSEX
    // -----------------------------------------------

    if (
      token ===
      indexData.sensex.token
    ) {

      updateIndex(
        "sensex",
        tick
      );

      return;
    }


    // -----------------------------------------------
    // CASH STOCK
    // -----------------------------------------------

    const stock =
      cashByToken.get(
        token
      );


    if (!stock) {

      return;
    }


    const data =
      parseTick(
        tick
      );


    if (
      data.price === null
    ) {

      return;
    }


    priceData[
      stock.symbol
    ] = {

      symbol:
        stock.symbol,

      price:
        data.price,

      close:
        data.close,

      change:
        data.change,

      changePercent:
        data.changePercent,

      timestamp:
        Date.now()
    };


    // Send every tick to browser.
    broadcast(
      "stockTick",
      priceData[
        stock.symbol
      ]
    );

  } catch (error) {

    addLog(
      `Tick error: ${error.message}`,
      "ERROR"
    );
  }
}


// =====================================================
// PARSE TICK
// =====================================================

function parseTick(
  tick
) {

  let price =
    Number(
      tick.last_traded_price ??
      tick.lastTradedPrice ??
      tick.ltp ??
      0
    );


  let close =
    Number(
      tick.close ??
      tick.closePrice ??
      tick.previous_close ??
      tick.previousClose ??
      0
    );


  if (
    price > 0
  ) {

    price =
      price / 100;
  }


  if (
    close > 0
  ) {

    close =
      close / 100;
  }


  let change =
    null;

  let changePercent =
    null;


  if (
    price > 0 &&
    close > 0
  ) {

    change =
      price -
      close;


    changePercent =
      (
        change /
        close
      ) * 100;
  }


  return {

    price:
      price > 0
        ? price
        : null,

    close:
      close > 0
        ? close
        : null,

    change,

    changePercent
  };
}


// =====================================================
// INDEX UPDATE
// =====================================================

function updateIndex(
  name,
  tick
) {

  const data =
    parseTick(
      tick
    );


  const item =
    indexData[name];


  if (
    data.price === null
  ) {

    return;
  }


  item.price =
    data.price;

  item.close =
    data.close;

  item.change =
    data.change;

  item.changePercent =
    data.changePercent;

  item.timestamp =
    Date.now();


  broadcast(
    "indexTick",
    {

      index:
        name,

      data:
        item

    }
  );
}


// =====================================================
// OI REFRESH
// =====================================================

async function refreshOI() {

  if (!smartApi) {

    return;
  }


  // VERY IMPORTANT:
  // Gainers + Losers are requested together.

  const [
    gainersResponse,
    losersResponse
  ] =
    await Promise.all([

      smartApi.gainersLosers({

        datatype:
          "PercOIGainers",

        expirytype:
          "NEAR"

      }),

      smartApi.gainersLosers({

        datatype:
          "PercOILosers",

        expirytype:
          "NEAR"

      })

    ]);


  if (
    !gainersResponse?.status
  ) {

    throw new Error(
      gainersResponse?.message ||
      "OI Gainers API failed."
    );
  }


  if (
    !losersResponse?.status
  ) {

    throw new Error(
      losersResponse?.message ||
      "OI Losers API failed."
    );
  }


  const gainers =
    convertOI(
      gainersResponse.data
    );


  const losers =
    convertOI(
      losersResponse.data
    );


  // ----------------------------------------------
  // STRICT OI CHANGE SORTING
  // ----------------------------------------------

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


  oiGainers =
    gainers.slice(
      0,
      10
    );


  oiLosers =
    losers.slice(
      0,
      10
    );


  broadcast(
    "oi",
    {

      gainers:
        oiGainers,

      losers:
        oiLosers

    }
  );


  addLog(
    `OI refreshed together: ${oiGainers.length} gainers / ${oiLosers.length} losers.`,
    "SUCCESS"
  );
}


// =====================================================
// CONVERT OI
// =====================================================

function convertOI(
  rows
) {

  if (
    !Array.isArray(rows)
  ) {

    return [];
  }


  return rows
    .map(
      item => {

        const symbol =
          getCashSymbolFromOI(
            item
          );


        if (!symbol) {

          return null;
        }


        const live =
          priceData[
            symbol
          ];


        return {

          symbol,

          // THIS is the sorting value
          oiPercent:
            Number(
              item.percentChange ||
              0
            ),

          openInterest:
            Number(
              item.opnInterest ||
              0
            ),

          oiChange:
            Number(
              item.netChangeOpnInterest ||
              0
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

          timestamp:
            Date.now()
        };
      }
    )
    .filter(
      Boolean
    );
}


// =====================================================
// STATUS
// =====================================================

function getStatus() {

  return {

    connected:
      Boolean(
        smartApi &&
        sessionData
      ),

    websocket:
      websocketReady,

    stocks:
      fnoCashUniverse.length,

    liveStocks:
      Object.keys(
        priceData
      ).length,

    indexes:
      indexState,

    indexData

  };
}


app.get(
  "/api/status",
  (
    req,
    res
  ) => {

    res.json(
      getStatus()
    );
  }
);


// =====================================================
// DATA
// =====================================================

app.get(
  "/api/data",
  (
    req,
    res
  ) => {

    res.json({

      success:
        Boolean(
          smartApi &&
          sessionData
        ),

      connected:
        Boolean(
          smartApi &&
          sessionData
        ),

      websocket:
        websocketReady,

      indexes:
        indexData,

      indexState,

      oiGainers,

      oiLosers

    });
  }
);


// =====================================================
// LOGS
// =====================================================

app.get(
  "/api/logs",
  (
    req,
    res
  ) => {

    res.json({

      success:
        true,

      logs:
        activityLogs

    });
  }
);


// =====================================================
// SSE STREAM
// =====================================================

app.get(
  "/api/stream",
  (
    req,
    res
  ) => {

    res.setHeader(
      "Content-Type",
      "text/event-stream"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache"
    );

    res.setHeader(
      "Connection",
      "keep-alive"
    );


    res.flushHeaders();


    clients.add(
      res
    );


    res.write(
      `event: status\ndata: ${JSON.stringify(getStatus())}\n\n`
    );


    res.write(
      `event: indexState\ndata: ${JSON.stringify(indexState)}\n\n`
    );


    res.write(
      `event: oi\ndata: ${JSON.stringify({
        gainers: oiGainers,
        losers: oiLosers
      })}\n\n`
    );


    res.write(
      `event: logs\ndata: ${JSON.stringify(activityLogs)}\n\n`
    );


    req.on(
      "close",
      () => {

        clients.delete(
          res
        );
      }
    );
  }
);


// =====================================================
// LOGOUT
// =====================================================

app.post(
  "/api/logout",
  (
    req,
    res
  ) => {

    try {

      if (oiRefreshTimer) {

        clearInterval(
          oiRefreshTimer
        );

        oiRefreshTimer =
          null;
      }


      if (webSocket) {

        try {

          webSocket.close();

        } catch (error) {}
      }


      smartApi =
        null;

      sessionData =
        null;

      webSocket =
        null;

      websocketReady =
        false;

      fnoCashUniverse =
        [];

      cashByToken =
        new Map();

      futureTokenToCash =
        new Map();

      futureSymbolToCash =
        new Map();

      priceData =
        {};

      oiGainers =
        [];

      oiLosers =
        [];


      indexState.nifty =
        false;

      indexState.sensex =
        false;


      addLog(
        "Broker logged out.",
        "INFO"
      );


      res.json({

        success:
          true

      });

    } catch (error) {

      res.json({

        success:
          true

      });
    }
  }
);


// =====================================================
// FRONTEND
// =====================================================

app.get(
  "/{*splat}",
  (
    req,
    res
  ) => {

    res.sendFile(
      __dirname +
      "/public/index.html"
    );
  }
);


// =====================================================
// SERVER
// =====================================================

app.listen(
  PORT,
  () => {

    addLog(
      `Server started on port ${PORT}.`
    );
  }
);
