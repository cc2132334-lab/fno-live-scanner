const express = require("express");
const cors = require("cors");
const https = require("https");

const {
  SmartAPI,
  WebSocketV2
} = require("smartapi-javascript");

const { generate } = require("otplib");


/* =========================================================
   APP
========================================================= */

const app = express();

const PORT =
  process.env.PORT || 3000;

app.use(cors());

app.use(express.json());

app.use(express.static("public"));


/* =========================================================
   ANGEL SESSION
========================================================= */

let angelSession = null;


/* =========================================================
   SCRIP MASTER
========================================================= */

const SCRIP_MASTER_URL =
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";

let scripMasterLoaded = false;


/*
  F&O stock universe

  key = underlying name

  value = NSE cash instrument
*/

const cashStocks = new Map();


/*
  Futures token -> cash stock mapping

  Example:

  56789
  =>
  {
    symbol: "RELIANCE",
    cashToken: "2885"
  }
*/

const futureToCash = new Map();


/* =========================================================
   VOLUME WEBSOCKET
========================================================= */

let volumeSocket = null;

let volumeReady = false;

let volumeSocketStarted = false;


/*
  Cash stock live data.
*/

const volumeData = new Map();


/* =========================================================
   HELPER: DOWNLOAD FILE
========================================================= */

function downloadScripMaster() {

  return new Promise(
    (resolve, reject) => {

      https.get(
        SCRIP_MASTER_URL,

        {
          headers: {
            "User-Agent":
              "Mozilla/5.0"
          }
        },

        (response) => {

          let body = "";


          if (
            response.statusCode !== 200
          ) {

            response.resume();

            reject(
              new Error(
                "Scrip master HTTP " +
                response.statusCode
              )
            );

            return;
          }


          response.setEncoding(
            "utf8"
          );


          response.on(
            "data",
            (chunk) => {

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

    }
  );

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
    .replace(
      /-EQ$/,
      ""
    );

}


/* =========================================================
   LOAD F&O + CASH MAPPING
========================================================= */

async function loadFNOUniverse() {

  console.log(
    "📥 Loading Angel One scrip master..."
  );


  const master =
    await downloadScripMaster();


  if (
    !Array.isArray(master)
  ) {

    throw new Error(
      "Scrip master is not an array"
    );

  }


  /*
    -----------------------------------------
    STEP 1
    Find NSE CASH / EQUITY stocks
    -----------------------------------------
  */

  const nseCash =
    new Map();


  for (
    const item of master
  ) {

    const exchange =
      String(
        item.exch_seg || ""
      ).toUpperCase();


    if (
      exchange !== "NSE"
    ) {

      continue;

    }


    const symbol =
      String(
        item.symbol || ""
      ).toUpperCase();


    /*
      We only want normal equity.

      Typical symbols:
      RELIANCE-EQ
      HDFCBANK-EQ
      TCS-EQ
    */

    if (
      !symbol.endsWith("-EQ")
    ) {

      continue;

    }


    const clean =
      cleanSymbol(
        symbol
      );


    if (!clean) {
      continue;
    }


    const token =
      String(
        item.token || ""
      );


    if (!token) {
      continue;
    }


    nseCash.set(
      clean,
      {

        symbol: clean,

        tradingSymbol:
          symbol,

        token,

        name:
          item.name ||
          clean

      }
    );

  }


  console.log(
    "💰 NSE cash stocks found:",
    nseCash.size
  );


  /*
    -----------------------------------------
    STEP 2
    Find F&O STOCK FUTURES
    -----------------------------------------
  */

  const fnoUnderlyings =
    new Set();


  const futureRecords =
    [];


  for (
    const item of master
  ) {

    const exchange =
      String(
        item.exch_seg || ""
      ).toUpperCase();


    if (
      exchange !== "NFO"
    ) {

      continue;

    }


    const instrumentType =
      String(
        item.instrumenttype || ""
      ).toUpperCase();


    /*
      FUTSTK = stock futures

      FUTIDX = index futures

      We DO NOT want index here.
    */

    if (
      instrumentType !== "FUTSTK"
    ) {

      continue;

    }


    const name =
      cleanSymbol(
        item.name
      );


    const token =
      String(
        item.token || ""
      );


    if (
      !name ||
      !token
    ) {

      continue;

    }


    /*
      Only keep stocks which have
      corresponding NSE cash equity.
    */

    const cash =
      nseCash.get(
        name
      );


    if (!cash) {

      continue;

    }


    fnoUnderlyings.add(
      name
    );


    futureRecords.push({

      futureToken:
        token,

      futureSymbol:
        item.symbol || "",

      underlying:
        name,

      cashSymbol:
        cash.symbol,

      cashToken:
        cash.token,

      cashTradingSymbol:
        cash.tradingSymbol

    });

  }


  console.log(
    "📊 F&O stock underlyings:",
    fnoUnderlyings.size
  );


  /*
    -----------------------------------------
    STEP 3
    Create future -> cash mapping
    -----------------------------------------
  */

  futureToCash.clear();


  for (
    const record of futureRecords
  ) {

    futureToCash.set(

      record.futureToken,

      {

        underlying:
          record.underlying,

        cashSymbol:
          record.cashSymbol,

        cashToken:
          record.cashToken,

        cashTradingSymbol:
          record.cashTradingSymbol

      }

    );

  }


  /*
    -----------------------------------------
    STEP 4
    Cash stocks for volume scanner
    -----------------------------------------
  */

  cashStocks.clear();


  for (
    const name of fnoUnderlyings
  ) {

    const cash =
      nseCash.get(
        name
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
    "💰 Cash stocks for volume:",
    cashStocks.size
  );


  return {

    cashStocks,

    futureToCash

  };

}


/* =========================================================
   START CASH VOLUME WEBSOCKET
========================================================= */

async function startVolumeWebSocket() {

  if (
    !angelSession
  ) {

    return;

  }


  try {

    if (
      volumeSocket
    ) {

      try {
        volumeSocket.close();
      } catch (_) {}

    }


    volumeSocket =
      null;

    volumeReady =
      false;

    volumeSocketStarted =
      false;

    volumeData.clear();


    /*
      Make sure F&O universe is loaded.
    */

    if (
      !scripMasterLoaded
    ) {

      await loadFNOUniverse();

    }


    const tokens =
      Array.from(
        cashStocks.keys()
      );


    if (
      !tokens.length
    ) {

      throw new Error(
        "No F&O eligible cash stocks found"
      );

    }


    /*
      WebSocket V2 supports batches.

      First 1000 are enough for this scanner.
    */

    const subscribeTokens =
      tokens.slice(
        0,
        1000
      );


    console.log(
      "🔌 Starting CASH volume WebSocket..."
    );


    console.log(
      "📡 NSE CASH tokens:",
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


    /*
      Tick data
    */

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
            Quote mode volume.
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


          const old =
            volumeData.get(
              token
            );


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

              previousVolume:
                old?.volume ??
                null,

              firstSeen:
                old?.firstSeen ??
                Date.now(),

              lastUpdate:
                Date.now()

            }
          );


        } catch (error) {

          console.error(
            "CASH VOLUME TICK ERROR:",
            error.message
          );

        }

      }
    );


    /*
      Connect WebSocket.
    */

    await volumeSocket.connect();


    /*
      Angel One WebSocket V2:

      action 1 = subscribe
      mode 2 = Quote
      exchangeType 1 = NSE Cash

      NSE cash exchange type = 1
    */

    volumeSocket.fetchData({

      correlationID:
        "nse-cash-volume",

      action: 1,

      mode: 2,

      exchangeType: 1,

      tokens:
        subscribeTokens

    });


    volumeReady =
      true;

    volumeSocketStarted =
      true;


    console.log(
      "🟢 NSE CASH VOLUME SOCKET CONNECTED"
    );


  } catch (error) {

    console.error(
      "❌ CASH VOLUME SOCKET ERROR:",
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
   STATUS
========================================================= */

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      success: true,

      message:
        "F&O Cash Stock Scanner server is running",

      angelConnected:
        !!angelSession,

      scripMasterLoaded,

      fnoStocks:
        cashStocks.size,

      cashVolumeSocket:
        volumeReady,

      liveCashStocks:
        volumeData.size

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
        Load F&O stocks -> CASH stocks.
      */

      await loadFNOUniverse();


      /*
        Start NSE cash volume feed.
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

      if (
        !angelSession
      ) {

        return res
          .status(401)
          .json({

            success: false,

            message:
              "Angel One is not connected"

          });

      }


      if (
        !scripMasterLoaded
      ) {

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


      /*
        Futures OI ko CASH symbol me convert.
      */

      const data =
        raw.map(
          (item) => {

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


            /*
              Agar mapping mil gayi,
              cash stock show karo.
            */

            if (
              mapping
            ) {

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


            /*
              Unknown futures ko
              remove kar denge.
            */

            return null;

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

      if (
        !angelSession
      ) {

        return res
          .status(401)
          .json({

            success: false,

            message:
              "Angel One is not connected"

          });

      }


      if (
        !scripMasterLoaded
      ) {

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
        raw.map(
          (item) => {

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


            if (
              mapping
            ) {

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


            return null;

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
   CASH VOLUME GAINERS
========================================================= */

app.get(
  "/api/volume-gainers",
  async (req, res) => {

    try {

      if (
        !angelSession
      ) {

        return res
          .status(401)
          .json({

            success: false,

            message:
              "Angel One is not connected"

          });

      }


      if (
        !volumeSocketStarted
      ) {

        await startVolumeWebSocket();

      }


      /*
        Cash stocks only.
      */

      const result =
        Array.from(
          volumeData.values()
        )
        .filter(
          item =>
            Number.isFinite(
              item.volume
            ) &&
            item.volume > 0
        )
        .map(
          item => {

            let volumeChange =
              null;

            let percentChange =
              null;


            /*
              First version:
              current cumulative cash volume.

              Later we can make proper
              1-minute volume acceleration.
            */

            if (
              Number.isFinite(
                item.previousVolume
              ) &&
              item.previousVolume > 0
            ) {

              volumeChange =
                item.volume -
                item.previousVolume;


              percentChange =
                (
                  volumeChange /
                  item.previousVolume
                ) * 100;

            }


            return {

              tradingSymbol:
                item.symbol,

              symbol:
                item.symbol,

              symbolToken:
                item.token,

              tradeVolume:
                item.volume,

              volumeChange,

              percentChange,

              ltp:
                item.ltp,

              exchange:
                "NSE"

            };

          }
        );


      /*
        Highest cash volume first.
      */

      result.sort(
        (a, b) =>
          Number(
            b.tradeVolume
          ) -
          Number(
            a.tradeVolume
          )
      );


      return res.json({

        success: true,

        data:
          result.slice(
            0,
            10
          )

      });


    } catch (error) {

      console.error(
        "CASH VOLUME ERROR:",
        error?.message ||
        error
      );


      return res
        .status(500)
        .json({

          success: false,

          message:
            error?.message ||
            "Unable to fetch cash volume"

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
