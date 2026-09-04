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

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.static("public")
);


// ======================================================
// GLOBAL STATE
// ======================================================

let smartApi = null;

let sessionData = null;

let webSocket = null;

let websocketReady = false;

let fnoCashUniverse = [];

let cashByToken = new Map();

let priceData = {};

let oiGainers = [];

let oiLosers = [];

let oiRefreshTimer = null;


// ======================================================
// INDEX STATE
// ======================================================

const indexState = {

  nifty: false,

  sensex: false

};


const indexData = {

  nifty: {
    name: "NIFTY",
    exchangeType: 1,
    token: "99926000",
    price: null,
    previousClose: null,
    change: null,
    changePercent: null,
    timestamp: null
  },

  sensex: {
    name: "SENSEX",
    exchangeType: 3,
    token: "99919000",
    price: null,
    previousClose: null,
    change: null,
    changePercent: null,
    timestamp: null
  }

};


// ======================================================
// SSE CLIENTS
// ======================================================

const streamClients =
  new Set();


// ======================================================
// ACTIVITY LOG
// ======================================================

let activityLogs = [];


function addLog(
  message,
  type = "INFO"
) {

  const item = {

    time:
      new Date().toISOString(),

    type,

    message
  };


  activityLogs.push(item);


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
    item
  );
}


// ======================================================
// SSE BROADCAST
// ======================================================

function broadcast(
  event,
  data
) {

  const payload =
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;


  for (
    const client of streamClients
  ) {

    try {

      client.write(payload);

    } catch (error) {

      streamClients.delete(
        client
      );
    }
  }
}


// ======================================================
// TOTP SECRET NORMALIZE
// ======================================================

function normalizeTotpSecret(
  input
) {

  if (!input) {

    return "";
  }


  let secret =
    String(input).trim();


  // If complete otpauth URI pasted
  if (
    secret
      .toLowerCase()
      .startsWith("otpauth://")
  ) {

    try {

      const url =
        new URL(secret);

      const uriSecret =
        url.searchParams.get(
          "secret"
        );


      if (uriSecret) {

        secret =
          uriSecret;
      }

    } catch (error) {

      addLog(
        "TOTP URI parsing failed; using entered value.",
        "WARN"
      );
    }
  }


  // If secret=XXXX format
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


// ======================================================
// BUILD SYMBOL NAME
// ======================================================

function cleanCashSymbol(
  symbol
) {

  if (!symbol) {

    return "";
  }


  return String(symbol)
    .replace(
      /-EQ$/i,
      ""
    )
    .trim()
    .toUpperCase();
}


// ======================================================
// FIND CASH SYMBOL FROM FUTURES SYMBOL
// ======================================================

function futureToCashSymbol(
  tradingSymbol
) {

  if (!tradingSymbol) {

    return "";
  }


  const future =
    String(
      tradingSymbol
    ).toUpperCase();


  // Longest symbol first
  // prevents prefix collision.
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
      future.startsWith(
        symbol
      ) &&
      future.endsWith(
        "FUT"
      )
    ) {

      return symbol;
    }
  }


  // Fallback:
  // remove expiry + FUT
  const match =
    future.match(
      /^(.+?)(\d{2}[A-Z]{3}\d{2})FUT$/
    );


  if (
    match &&
    match[1]
  ) {

    return match[1];
  }


  return "";
}


// ======================================================
// DOWNLOAD MASTER + BUILD F&O CASH UNIVERSE
// ======================================================

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
      "Instrument master download failed."
    );
  }


  const master =
    await response.json();


  if (
    !Array.isArray(master)
  ) {

    throw new Error(
      "Invalid instrument master response."
    );
  }


  // ----------------------------------------------
  // F&O STOCK NAMES
  // ----------------------------------------------

  const fnoNames =
    new Set();


  for (
    const item of master
  ) {

    if (
      item.exch_seg === "NFO" &&
      item.instrumenttype === "FUTSTK" &&
      item.name
    ) {

      fnoNames.add(
        cleanCashSymbol(
          item.name
        )
      );
    }
  }


  // ----------------------------------------------
  // NSE CASH EQUITY
  // ----------------------------------------------

  const map =
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
        cleanCashSymbol(
          item.symbol
        );


      if (
        fnoNames.has(
          symbol
        )
      ) {

        map.set(
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
      map.values()
    );


  cashByToken =
    new Map();


  for (
    const item of
    fnoCashUniverse
  ) {

    cashByToken.set(
      item.token,
      item
    );
  }


  addLog(
    `F&O cash universe ready: ${fnoCashUniverse.length} NSE stocks.`,
    "SUCCESS"
  );
}


// ======================================================
// LOGIN
// ======================================================

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
        `Login started for Client ID ${String(clientId).trim()}.`
      );


      // ------------------------------------------
      // TOTP SECRET
      // ------------------------------------------

      const secret =
        normalizeTotpSecret(
          totpSecret
        );


      if (!secret) {

        return res
          .status(400)
          .json({

            success: false,

            message:
              "TOTP Secret empty hai."
          });
      }


      addLog(
        `TOTP Secret received. Length: ${secret.length}.`
      );


      // ------------------------------------------
      // GENERATE CURRENT 6 DIGIT TOTP
      // ------------------------------------------

      const currentTotp =
        await generate({
          secret
        });


      addLog(
        "Current TOTP generated successfully.",
        "SUCCESS"
      );


      // ------------------------------------------
      // SMART API
      // ------------------------------------------

      smartApi =
        new SmartAPI({
          api_key:
            String(
              apiKey
            ).trim()
        });


      // ------------------------------------------
      // LOGIN
      // ------------------------------------------

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

        addLog(
          loginResponse?.message ||
          "Angel One login failed.",
          "ERROR"
        );


        return res
          .status(401)
          .json({

            success: false,

            message:
              loginResponse?.message ||
              loginResponse?.errorcode ||
              "Angel One login failed."
          });
      }


      sessionData =
        loginResponse.data;


      // ------------------------------------------
      // FEED TOKEN
      // ------------------------------------------

      let feedToken =
        sessionData.feedToken;


      if (!feedToken) {

        try {

          feedToken =
            smartApi.getfeedToken();

          feedToken =
            await Promise.resolve(
              feedToken
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


      // ------------------------------------------
      // MASTER
      // ------------------------------------------

      await buildUniverse();


      // ------------------------------------------
      // RESET INDEX TOGGLES
      // ------------------------------------------

      indexState.nifty =
        false;

      indexState.sensex =
        false;


      // ------------------------------------------
      // WEBSOCKET
      // ------------------------------------------

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


      // ------------------------------------------
      // FIRST OI LOAD
      // ------------------------------------------

      await refreshOI();


      // ------------------------------------------
      // REPEATED OI REFRESH
      // ------------------------------------------

      if (oiRefreshTimer) {

        clearInterval(
          oiRefreshTimer
        );
      }


      oiRefreshTimer =
        setInterval(
          () => {

            refreshOI()
              .catch(
                error => {

                  addLog(
                    `OI refresh error: ${error.message}`,
                    "ERROR"
                  );
                }
              );

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
        `Login error: ${error.message}`,
        "ERROR"
      );


      return res
        .status(401)
        .json({

          success: false,

          message:
            error?.message ||
            "Login failed."
        });
    }
  }
);


// ======================================================
// START WEBSOCKET
// ======================================================

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
      "JWT token or feed token missing."
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

      let settled =
        false;


      webSocket.connect()
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
                  "SmartAPI WebSocket closed.",
                  "WARN"
                );


                broadcast(
                  "status",
                  getStatus()
                );
              }
            );


            // --------------------------------------
            // SUBSCRIBE F&O CASH STOCKS
            // --------------------------------------

            subscribeFnoCash();


            if (!settled) {

              settled =
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


            if (!settled) {

              settled =
                true;

              reject(error);
            }
          }
        );
    }
  );
}


// ======================================================
// SUBSCRIBE F&O CASH STOCKS
// ======================================================

function subscribeFnoCash() {

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


  // SmartAPI session quota is 1000.
  // Keep requests comfortably below that.
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


    try {

      webSocket.fetchData({

        correlationID:
          `fno${Math.floor(i / chunkSize)}`,

        action: 1,

        mode: 2,

        exchangeType: 1,

        tokens: chunk

      });

    } catch (error) {

      addLog(
        `F&O cash subscription error: ${error.message}`,
        "ERROR"
      );
    }
  }


  addLog(
    `Subscribed to ${tokens.length} F&O cash stocks for live Quote ticks.`,
    "SUCCESS"
  );
}


// ======================================================
// INDEX SUBSCRIBE / UNSUBSCRIBE
// ======================================================

function changeIndexSubscription(
  indexName,
  enabled
) {

  if (
    !webSocket ||
    !websocketReady
  ) {

    throw new Error(
      "WebSocket is not connected."
    );
  }


  const item =
    indexData[indexName];


  if (!item) {

    throw new Error(
      "Invalid index."
    );
  }


  webSocket.fetchData({

    correlationID:
      `${indexName}01`,

    action:
      enabled ? 1 : 0,

    mode: 1,

    exchangeType:
      item.exchangeType,

    tokens: [
      item.token
    ]

  });


  indexState[indexName] =
    enabled;


  addLog(
    `${item.name} live tick ${enabled ? "ON" : "OFF"}.`,
    enabled
      ? "SUCCESS"
      : "INFO"
  );


  broadcast(
    "indexState",
    indexState
  );
}


// ======================================================
// INDEX TOGGLE API
// ======================================================

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


      changeIndexSubscription(
        index,
        Boolean(enabled)
      );


      res.json({

        success: true,

        indexState,

        indexData
      });


    } catch (error) {

      addLog(
        `Index toggle error: ${error.message}`,
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


// ======================================================
// HANDLE LIVE TICKS
// ======================================================

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


    // ------------------------------------------
    // NIFTY
    // ------------------------------------------

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


    // ------------------------------------------
    // SENSEX
    // ------------------------------------------

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


    // ------------------------------------------
    // CASH STOCK
    // ------------------------------------------

    const stock =
      cashByToken.get(
        token
      );


    if (!stock) {

      return;
    }


    const data =
      parseQuoteTick(
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


    // ------------------------------------------
    // Only send ticks for stocks currently
    // visible in OI tables.
    // ------------------------------------------

    const visible =
      new Set([

        ...oiGainers.map(
          x => x.symbol
        ),

        ...oiLosers.map(
          x => x.symbol
        )

      ]);


    if (
      visible.has(
        stock.symbol
      )
    ) {

      broadcast(
        "stockTick",
        priceData[
          stock.symbol
        ]
      );
    }

  } catch (error) {

    addLog(
      `Tick processing error: ${error.message}`,
      "ERROR"
    );
  }
}


// ======================================================
// PARSE QUOTE TICK
// ======================================================

function parseQuoteTick(
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


  // SmartAPI binary parser returns price values
  // in paise for market-feed packets.
  if (
    price > 0
  ) {

    price =
      price / 100;
  }


  if (
    close > 0 &&
    close > 100000
  ) {

    close =
      close / 100;
  }


  let change = null;

  let changePercent = null;


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


// ======================================================
// UPDATE INDEX
// ======================================================

function updateIndex(
  indexName,
  tick
) {

  const parsed =
    parseQuoteTick(
      tick
    );


  const item =
    indexData[
      indexName
    ];


  item.price =
    parsed.price;


  item.previousClose =
    parsed.close;


  item.change =
    parsed.change;


  item.changePercent =
    parsed.changePercent;


  item.timestamp =
    Date.now();


  broadcast(
    "indexTick",
    {
      index:
        indexName,

      data:
        item
    }
  );
}


// ======================================================
// REFRESH OI
// ======================================================

async function refreshOI() {

  if (!smartApi) {

    return;
  }


  try {

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


    oiGainers =
      convertOIRows(
        gainersResponse.data
      )
        .sort(
          (a, b) =>
            b.oiPercent -
            a.oiPercent
        )
        .slice(
          0,
          10
        );


    oiLosers =
      convertOIRows(
        losersResponse.data
      )
        .sort(
          (a, b) =>
            a.oiPercent -
            b.oiPercent
        )
        .slice(
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
      `OI refreshed: ${oiGainers.length} gainers / ${oiLosers.length} losers.`,
      "SUCCESS"
    );


  } catch (error) {

    addLog(
      `OI refresh failed: ${error.message}`,
      "ERROR"
    );


    throw error;
  }
}


// ======================================================
// CONVERT OI RESPONSE
// ======================================================

function convertOIRows(
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

        const tradingSymbol =
          item.tradingSymbol ||
          "";


        const symbol =
          futureToCashSymbol(
            tradingSymbol
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

          updatedAt:
            Date.now()
        };
      }
    )
    .filter(
      Boolean
    );
}


// ======================================================
// STATUS
// ======================================================

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

    indexData,

    lastUpdate:
      Date.now()
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


// ======================================================
// INITIAL DATA
// ======================================================

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


// ======================================================
// ACTIVITY LOG API
// ======================================================

app.get(
  "/api/logs",
  (
    req,
    res
  ) => {

    res.json({

      success: true,

      logs:
        activityLogs
    });
  }
);


// ======================================================
// REALTIME STREAM
// ======================================================

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


    streamClients.add(
      res
    );


    // Initial state
    res.write(
      `event: status\ndata: ${JSON.stringify(getStatus())}\n\n`
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

        streamClients.delete(
          res
        );
      }
    );
  }
);


// ======================================================
// LOGOUT
// ======================================================

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


      webSocket =
        null;

      websocketReady =
        false;

      smartApi =
        null;

      sessionData =
        null;

      fnoCashUniverse =
        [];

      cashByToken =
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
        "Logged out from Angel One."
      );


      res.json({

        success: true
      });


    } catch (error) {

      res.json({

        success: true
      });
    }
  }
);


// ======================================================
// FRONTEND
// ======================================================

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


// ======================================================
// START
// ======================================================

app.listen(
  PORT,
  () => {

    addLog(
      `Server started on port ${PORT}.`
    );
  }
);
