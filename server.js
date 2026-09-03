const express = require("express");
const cors = require("cors");
const https = require("https");

const {
  SmartAPI,
  WebSocketV2
} = require("smartapi-javascript");

const { generate } = require("otplib");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

let angelSession = null;


/* =========================================================
   SCRIP MASTER
========================================================= */

const SCRIP_MASTER_URL =
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";

let scripMasterLoaded = false;

const cashStocks = new Map();

const futureToCash = new Map();


/* =========================================================
   CASH VOLUME
========================================================= */

let volumeSocket = null;

let volumeReady = false;

let volumeSocketStarted = false;


/*
  token -> current live data
*/
const volumeData = new Map();


/*
  token -> rolling volume samples

  Example:

  [
    { time: 1000, volume: 50000 },
    { time: 5000, volume: 52000 },
    ...
  ]
*/
const volumeHistory = new Map();


/*
  Keep 2 minutes history.
*/
const HISTORY_MS = 2 * 60 * 1000;


/* =========================================================
   DOWNLOAD SCRIP MASTER
========================================================= */

function downloadScripMaster() {

  return new Promise((resolve, reject) => {

    https.get(
      SCRIP_MASTER_URL,
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      },
      (response) => {

        let body = "";

        if (response.statusCode !== 200) {

          response.resume();

          reject(
            new Error(
              "Scrip master HTTP " +
              response.statusCode
            )
          );

          return;
        }

        response.setEncoding("utf8");

        response.on(
          "data",
          chunk => {
            body += chunk;
          }
        );

        response.on(
          "end",
          () => {

            try {

              resolve(
                JSON.parse(body)
              );

            } catch (error) {

              reject(
                new Error(
                  "Invalid scrip master JSON"
                )
              );

            }

          }
        );

      }
    ).on(
      "error",
      reject
    );

  });

}


/* =========================================================
   CLEAN SYMBOL
========================================================= */

function cleanSymbol(value) {

  if (!value) {
    return "";
  }

  return String(value)
    .toUpperCase()
    .trim()
    .replace(/-EQ$/, "");

}


/* =========================================================
   LOAD F&O STOCK -> CASH STOCK
========================================================= */

async function loadFNOUniverse() {

  console.log(
    "📥 Loading Angel One scrip master..."
  );

  const master =
    await downloadScripMaster();


  if (!Array.isArray(master)) {

    throw new Error(
      "Scrip master is not an array"
    );

  }


  /* =======================================================
     NSE CASH
  ======================================================= */

  const nseCash = new Map();


  for (const item of master) {

    const exchange =
      String(
        item.exch_seg || ""
      ).toUpperCase();


    if (exchange !== "NSE") {
      continue;
    }


    const symbol =
      String(
        item.symbol || ""
      ).toUpperCase();


    if (!symbol.endsWith("-EQ")) {
      continue;
    }


    const clean =
      cleanSymbol(symbol);


    const token =
      String(
        item.token || ""
      );


    if (!clean || !token) {
      continue;
    }


    nseCash.set(
      clean,
      {
        symbol: clean,
        tradingSymbol: symbol,
        token,
        name:
          item.name ||
          clean
      }
    );

  }


  console.log(
    "💰 NSE CASH stocks:",
    nseCash.size
  );


  /* =======================================================
     F&O STOCK FUTURES
  ======================================================= */

  const fnoUnderlyings =
    new Set();


  const futures = [];


  for (const item of master) {

    const exchange =
      String(
        item.exch_seg || ""
      ).toUpperCase();


    if (exchange !== "NFO") {
      continue;
    }


    const instrumentType =
      String(
        item.instrumenttype || ""
      ).toUpperCase();


    /*
      Only stock futures.

      FUTIDX ko intentionally exclude
      kar rahe hain.
    */

    if (
      instrumentType !== "FUTSTK"
    ) {

      continue;
    }


    const underlying =
      cleanSymbol(
        item.name
      );


    const futureToken =
      String(
        item.token || ""
      );


    if (
      !underlying ||
      !futureToken
    ) {

      continue;
    }


    const cash =
      nseCash.get(
        underlying
      );


    if (!cash) {
      continue;
    }


    fnoUnderlyings.add(
      underlying
    );


    futures.push({

      futureToken,

      futureSymbol:
        item.symbol || "",

      underlying,

      cashSymbol:
        cash.symbol,

      cashToken:
        cash.token,

      cashTradingSymbol:
        cash.tradingSymbol

    });

  }


  console.log(
    "📊 F&O STOCK underlyings:",
    fnoUnderlyings.size
  );


  /* =======================================================
     FUTURE -> CASH MAPPING
  ======================================================= */

  futureToCash.clear();


  for (const item of futures) {

    futureToCash.set(
      item.futureToken,
      {

        underlying:
          item.underlying,

        cashSymbol:
          item.cashSymbol,

        cashToken:
          item.cashToken,

        cashTradingSymbol:
          item.cashTradingSymbol

      }
    );

  }


  /* =======================================================
     CASH STOCKS FOR LIVE VOLUME
  ======================================================= */

  cashStocks.clear();


  for (
    const underlying of
    fnoUnderlyings
  ) {

    const cash =
      nseCash.get(
        underlying
      );


    if (!cash) {
      continue;
    }


    cashStocks.set(
      cash.token,
      {

        symbol:
          cash.symbol,

        tradingSymbol:
          cash.tradingSymbol,

        token:
          cash.token,

        name:
          cash.name

      }
    );

  }


  scripMasterLoaded =
    true;


  console.log(
    "🟢 F&O -> CASH mapping ready"
  );


  console.log(
    "💰 CASH volume stocks:",
    cashStocks.size
  );

}


/* =========================================================
   START CASH WEBSOCKET
========================================================= */

async function startVolumeWebSocket() {

  if (!angelSession) {
    return;
  }


  try {

    if (volumeSocket) {

      try {
        volumeSocket.close();
      } catch (_) {}

    }


    volumeSocket = null;

    volumeReady = false;

    volumeSocketStarted = false;


    volumeData.clear();

    volumeHistory.clear();


    if (!scripMasterLoaded) {

      await loadFNOUniverse();

    }


    const tokens =
      Array.from(
        cashStocks.keys()
      );


    if (!tokens.length) {

      throw new Error(
        "No F&O eligible cash stocks found"
      );

    }


    /*
      Angel One WebSocket:
      max 1000 tokens per connection.

      Our first 1000 F&O stocks.
    */

    const subscribeTokens =
      tokens.slice(
        0,
        1000
      );


    console.log(
      "🔌 Starting NSE CASH WebSocket..."
    );


    console.log(
      "📡 Cash tokens:",
      subscribeTokens.length
    );


    volumeSocket =
      new WebSocketV2({

        jwttoken:
          angelSession.authToken,

        apikey:
          angelSession.apiKey,

        clientcode:
          angelSession.clientCode,

        feedtype:
          angelSession.feedToken

      });


    /* =====================================================
       TICK
    ===================================================== */

    volumeSocket.on(
      "tick",
      (tick) => {

        try {

          if (!tick) {
            return;
          }


          const token =
            String(
              tick.token || ""
            )
            .replace(
              /"/g,
              ""
            );


          if (!token) {
            return;
          }


          const stock =
            cashStocks.get(
              token
            );


          if (!stock) {
            return;
          }


          /*
            IMPORTANT:

            smartapi-javascript WebSocketV2
            parser me field:

            vol_traded

            hota hai.
          */

          const volume =
            Number(
              tick.vol_traded
            );


          if (
            !Number.isFinite(
              volume
            )
          ) {

            return;
          }


          const ltp =
            Number(
              tick.last_traded_price ||
              0
            ) / 100;


          const now =
            Date.now();


          volumeData.set(
            token,
            {

              token,

              symbol:
                stock.symbol,

              tradingSymbol:
                stock.tradingSymbol,

              name:
                stock.name,

              volume,

              ltp,

              lastUpdate:
                now

            }
          );


          /*
            -----------------------------------------------
            ROLLING HISTORY
            -----------------------------------------------

            Har tick ka current cumulative
            traded volume save karenge.
          */

          let history =
            volumeHistory.get(
              token
            );


          if (!history) {

            history = [];

            volumeHistory.set(
              token,
              history
            );

          }


          /*
            Same volume repeatedly aane par
            unnecessary entries avoid.
          */

          const last =
            history[
              history.length - 1
            ];


          if (
            !last ||
            last.volume !== volume
          ) {

            history.push({

              time: now,

              volume

            });

          }


          /*
            2 minute se purane samples
            remove.
          */

          const cutoff =
            now - HISTORY_MS;


          while (
            history.length > 0 &&
            history[0].time < cutoff
          ) {

            history.shift();

          }


        } catch (error) {

          console.error(
            "TICK ERROR:",
            error.message
          );

        }

      }
    );


    /*
      Connect first.
    */

    await volumeSocket.connect();


    /*
      ======================================================
      MODE 3 = SNAP QUOTE

      Isme volume field definitely parser
      ke through available hai.

      exchangeType 1 = NSE CASH
      action 1 = subscribe
      ======================================================
    */

    volumeSocket.fetchData({

      correlationID:
        "nse-cash-volume",

      action: 1,

      mode: 3,

      exchangeType: 1,

      tokens:
        subscribeTokens

    });


    volumeReady =
      true;

    volumeSocketStarted =
      true;


    console.log(
      "🟢 NSE CASH VOLUME WEBSOCKET CONNECTED"
    );


  } catch (error) {

    console.error(
      "❌ CASH WEBSOCKET ERROR:",
      error?.message ||
      error
    );


    volumeReady =
      false;

    volumeSocketStarted =
      false;

  }

}


/* =========================================================
   FIND 60 SECOND OLD VOLUME
========================================================= */

function getOldVolume(
  history,
  now
) {

  const target =
    now - 60 * 1000;


  let candidate =
    null;


  for (
    let i = 0;
    i < history.length;
    i++
  ) {

    if (
      history[i].time <= target
    ) {

      candidate =
        history[i];

    } else {

      break;

    }

  }


  return candidate;

}


/* =========================================================
   CALCULATE VOLUME GAINERS
========================================================= */

function getVolumeGainers() {

  const now =
    Date.now();


  const result = [];


  for (
    const item of
    volumeData.values()
  ) {

    const history =
      volumeHistory.get(
        item.token
      );


    if (
      !history ||
      history.length < 2
    ) {

      continue;

    }


    const oldSample =
      getOldVolume(
        history,
        now
      );


    if (!oldSample) {

      /*
        Stock ke paas abhi
        60 second history nahi hai.
      */

      continue;

    }


    const currentVolume =
      Number(
        item.volume
      );


    const oldVolume =
      Number(
        oldSample.volume
      );


    if (
      !Number.isFinite(
        currentVolume
      ) ||
      !Number.isFinite(
        oldVolume
      )
    ) {

      continue;

    }


    const increase =
      Math.max(
        0,
        currentVolume -
        oldVolume
      );


    if (
      increase <= 0
    ) {

      continue;

    }


    /*
      Volume percentage.

      Formula:

      (60 sec volume increase /
       volume at 60 sec ago)
       * 100
    */

    let percent =
      0;


    if (
      oldVolume > 0
    ) {

      percent =
        (
          increase /
          oldVolume
        ) * 100;

    }


    result.push({

      tradingSymbol:
        item.symbol,

      symbol:
        item.symbol,

      symbolToken:
        item.token,

      tradeVolume:
        currentVolume,

      volumeChange:
        increase,

      percentChange:
        percent,

      ltp:
        item.ltp,

      exchange:
        "NSE",

      ageSeconds:
        Math.round(
          (
            now -
            oldSample.time
          ) / 1000
        )

    });

  }


  /*
    Highest volume increase %
    first.
  */

  result.sort(
    (a, b) => {

      const percentDiff =
        Number(
          b.percentChange
        ) -
        Number(
          a.percentChange
        );


      if (
        percentDiff !== 0
      ) {

        return percentDiff;

      }


      return (
        Number(
          b.volumeChange
        ) -
        Number(
          a.volumeChange
        )
      );

    }
  );


  return result.slice(
    0,
    10
  );

}


/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      success: true,

      angelConnected:
        !!angelSession,

      scripMasterLoaded,

      fnoStocks:
        cashStocks.size,

      cashVolumeSocket:
        volumeReady,

      liveCashStocks:
        volumeData.size,

      historyStocks:
        volumeHistory.size

    });

  }
);


/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/login",
  async (req, res) => {

    try {

      const {
        apiKey,
        clientCode,
        mpin,
        totpSecret
      } = req.body;


      if (
        !apiKey ||
        !clientCode ||
        !mpin ||
        !totpSecret
      ) {

        return res
          .status(400)
          .json({

            success: false,

            message:
              "Please fill all fields"

          });

      }


      const cleanSecret =
        totpSecret
          .replace(
            /\s/g,
            ""
          )
          .toUpperCase();


      const totp =
        await generate({

          secret:
            cleanSecret

        });


      const smartApi =
        new SmartAPI({

          api_key:
            apiKey

        });


      const session =
        await smartApi.generateSession(

          clientCode,

          mpin,

          totp

        );


      if (
        !session ||
        !session.data
      ) {

        console.log(
          "LOGIN RESPONSE:",
          session
        );


        return res
          .status(401)
          .json({

            success: false,

            message:
              session?.message ||
              session?.errorcode ||
              "Angel One login failed"

          });

      }


      angelSession = {

        smartApi,

        apiKey,

        clientCode,

        authToken:
          session.data.jwtToken,

        refreshToken:
          session.data.refreshToken,

        feedToken:
          session.data.feedToken

      };


      console.log(
        "🟢 ANGEL ONE CONNECTED"
      );


      /*
        F&O universe -> Cash stocks
      */

      await loadFNOUniverse();


      /*
        Start cash market volume.
      */

      await startVolumeWebSocket();


      return res.json({

        success: true,

        message:
          "Angel One connected successfully",

        cashVolumeSocket:
          volumeReady,

        fnoStocks:
          cashStocks.size

      });


    } catch (error) {

      console.error(
        "LOGIN ERROR:",
        error?.message ||
        error
      );


      return res
        .status(500)
        .json({

          success: false,

          message:
            error?.message ||
            "Angel One login failed"

        });

    }

  }
);


/* =========================================================
   OI GAINERS
========================================================= */

app.get(
  "/api/oi-gainers",
  async (req, res) => {

    try {

      if (!angelSession) {

        return res
          .status(401)
          .json({

            success: false,

            message:
              "Angel One is not connected"

          });

      }


      if (!scripMasterLoaded) {

        await loadFNOUniverse();

      }


      const result =
        await angelSession
          .smartApi
          .gainersLosers({

            datatype:
              "PercOIGainers",

            expirytype:
              "NEAR"

          });


      const raw =
        Array.isArray(
          result?.data
        )
          ? result.data
          : [];


      const data =
        raw
          .map(
            item => {

              const futureToken =
                String(
                  item.symbolToken ||
                  item.token ||
                  ""
                );


              const mapping =
                futureToCash.get(
                  futureToken
                );


              if (!mapping) {
                return null;
              }


              return {

                ...item,

                tradingSymbol:
                  mapping.cashSymbol,

                symbol:
                  mapping.cashSymbol,

                cashSymbol:
                  mapping.cashSymbol,

                cashToken:
                  mapping.cashToken,

                futuresSymbol:
                  item.tradingSymbol ||
                  item.symbol ||
                  ""

              };

            }
          )
          .filter(Boolean);


      return res.json({

        success: true,

        data

      });


    } catch (error) {

      console.error(
        "OI GAINERS ERROR:",
        error?.message ||
        error
      );


      return res
        .status(500)
        .json({

          success: false,

          message:
            error?.message ||
            "Unable to fetch OI gainers"

        });

    }

  }
);


/* =========================================================
   OI LOSERS
========================================================= */

app.get(
  "/api/oi-losers",
  async (req, res) => {

    try {

      if (!angelSession) {

        return res
          .status(401)
          .json({

            success: false,

            message:
              "Angel One is not connected"

          });

      }


      if (!scripMasterLoaded) {

        await loadFNOUniverse();

      }


      const result =
        await angelSession
          .smartApi
          .gainersLosers({

            datatype:
              "PercOILosers",

            expirytype:
              "NEAR"

          });


      const raw =
        Array.isArray(
          result?.data
        )
          ? result.data
          : [];


      const data =
        raw
          .map(
            item => {

              const futureToken =
                String(
                  item.symbolToken ||
                  item.token ||
                  ""
                );


              const mapping =
                futureToCash.get(
                  futureToken
                );


              if (!mapping) {
                return null;
              }


              return {

                ...item,

                tradingSymbol:
                  mapping.cashSymbol,

                symbol:
                  mapping.cashSymbol,

                cashSymbol:
                  mapping.cashSymbol,

                cashToken:
                  mapping.cashToken,

                futuresSymbol:
                  item.tradingSymbol ||
                  item.symbol ||
                  ""

              };

            }
          )
          .filter(Boolean);


      return res.json({

        success: true,

        data

      });


    } catch (error) {

      console.error(
        "OI LOSERS ERROR:",
        error?.message ||
        error
      );


      return res
        .status(500)
        .json({

          success: false,

          message:
            error?.message ||
            "Unable to fetch OI losers"

        });

    }

  }
);


/* =========================================================
   VOLUME GAINERS
========================================================= */

app.get(
  "/api/volume-gainers",
  async (req, res) => {

    try {

      if (!angelSession) {

        return res
          .status(401)
          .json({

            success: false,

            message:
              "Angel One is not connected"

          });

      }


      if (!volumeSocketStarted) {

        await startVolumeWebSocket();

      }


      const data =
        getVolumeGainers();


      return res.json({

        success: true,

        data,

        intervalSeconds:
          60,

        collecting:
          data.length === 0

      });


    } catch (error) {

      console.error(
        "VOLUME GAINERS ERROR:",
        error?.message ||
        error
      );


      return res
        .status(500)
        .json({

          success: false,

          message:
            error?.message ||
            "Unable to fetch volume gainers"

        });

    }

  }
);


/* =========================================================
   FRONTEND
========================================================= */

app.get(
  "/{*splat}",
  (req, res) => {

    res.sendFile(
      __dirname +
      "/public/index.html"
    );

  }
);


/* =========================================================
   SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Server running on port ${PORT}`
    );

  }
);
