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

app.use(
  express.static("public")
);


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
  F&O eligible CASH stocks

  token -> stock information
*/

const cashStocks = new Map();


/*
  Futures token -> cash stock mapping

  OI data futures se aayega,
  lekin display CASH symbol ka hoga.
*/

const futureToCash = new Map();


/* =========================================================
   CASH VOLUME WEBSOCKET
========================================================= */

let volumeSocket = null;

let volumeReady = false;

let volumeSocketStarted = false;


/*
  Current live cumulative volume.

  token -> data
*/

const volumeData = new Map();


/*
  60-second interval starting volume.

  token -> volume at beginning
  of current 60-second interval
*/

const intervalStartVolume =
  new Map();


/*
  Last completed 60-second metrics.

  token ->

  {
    volume,
    volumeIncrease,
    volumeIncreasePercent,
    timestamp
  }
*/

const volumeMetrics =
  new Map();


/*
  First interval ke liye data
  collect hone ka status.
*/

let volumeIntervalReady = false;


/*
  60 seconds
*/

const VOLUME_INTERVAL =
  60 * 1000;


/* =========================================================
   DOWNLOAD SCRIP MASTER
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

                const data =
                  JSON.parse(body);

                resolve(data);

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
   LOAD F&O STOCK UNIVERSE
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
    ========================================================
    STEP 1
    NSE CASH EQUITY
    ========================================================
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
      Normal NSE equity symbols:
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


    const token =
      String(
        item.token || ""
      );


    if (
      !clean ||
      !token
    ) {

      continue;

    }


    nseCash.set(
      clean,
      {

        symbol:
          clean,

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
    "💰 NSE CASH stocks:",
    nseCash.size
  );


  /*
    ========================================================
    STEP 2
    F&O STOCK FUTURES
    ========================================================
  */

  const fnoUnderlyings =
    new Set();


  const futures =
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


    /*
      FUTSTK = Stock Futures

      FUTIDX = Index Futures

      Hume sirf STOCK FUTURES chahiye.
    */

    const instrumentType =
      String(
        item.instrumenttype || ""
      ).toUpperCase();


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


    /*
      Corresponding NSE cash stock
      exist karna chahiye.
    */

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


  /*
    ========================================================
    STEP 3
    FUTURES -> CASH MAPPING
    ========================================================
  */

  futureToCash.clear();


  for (
    const item of futures
  ) {

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


  /*
    ========================================================
    STEP 4
    CASH STOCKS FOR VOLUME SCANNER
    ========================================================
  */

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
    "💰 CASH stocks for volume:",
    cashStocks.size
  );


  return {

    cashStocks,

    futureToCash

  };

}


/* =========================================================
   START NSE CASH VOLUME WEBSOCKET
========================================================= */

async function startVolumeWebSocket() {

  if (
    !angelSession
  ) {

    return;

  }


  try {

    /*
      Old socket close.
    */

    if (
      volumeSocket
    ) {

      try {

        volumeSocket.close();

      } catch (_) {}

    }


    volumeSocket = null;

    volumeReady = false;

    volumeSocketStarted = false;


    /*
      Clear old data.
    */

    volumeData.clear();

    intervalStartVolume.clear();

    volumeMetrics.clear();

    volumeIntervalReady = false;


    /*
      Make sure universe exists.
    */

    if (
      !scripMasterLoaded
    ) {

      await loadFNOUniverse();

    }


    /*
      Cash tokens.
    */

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
      WebSocket per connection
      max 1000 tokens.

      First 1000 stocks.
    */

    const subscribeTokens =
      tokens.slice(
        0,
        1000
      );


    console.log(
      "🔌 Starting NSE CASH volume WebSocket..."
    );


    console.log(
      "📡 CASH tokens:",
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
      ======================================================
      LIVE TICK
      ======================================================
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
            Angel One Quote mode:

            vol_traded =
            cumulative traded volume
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


          /*
            Save live current volume.
          */

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
                Date.now()

            }

          );


          /*
            First tick for a stock
            becomes start volume.
          */

          if (
            !intervalStartVolume.has(
              token
            )
          ) {

            intervalStartVolume.set(
              token,
              volume
            );

          }

        } catch (error) {

          console.error(
            "CASH VOLUME TICK ERROR:",
            error.message
          );

        }

      }
    );


    /*
      Connect.
    */

    await volumeSocket.connect();


    /*
      ======================================================
      ANGEL ONE WEBSOCKET V2

      action 1 = Subscribe
      mode 2   = Quote
      exchangeType 1 = NSE CASH
      ======================================================
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
   CALCULATE 60 SECOND VOLUME GAIN
========================================================= */

function calculateVolumeInterval() {

  if (
    !volumeReady
  ) {

    return;

  }


  let calculated =
    0;


  /*
    Current live volume ko
    interval-end snapshot samjho.
  */

  for (
    const item of
    volumeData.values()
  ) {

    const currentVolume =
      Number(
        item.volume
      );


    if (
      !Number.isFinite(
        currentVolume
      )
    ) {

      continue;

    }


    const startVolume =
      Number(
        intervalStartVolume.get(
          item.token
        )
      );


    if (
      !Number.isFinite(
        startVolume
      )
    ) {

      /*
        Agar stock beech me
        start hua hai to next
        interval se calculate hoga.
      */

      intervalStartVolume.set(
        item.token,
        currentVolume
      );

      continue;

    }


    const increase =
      Math.max(
        0,
        currentVolume -
        startVolume
      );


    let percent =
      null;


    if (
      startVolume > 0
    ) {

      percent =
        (
          increase /
          startVolume
        ) * 100;

    }


    /*
      Save completed interval.
    */

    volumeMetrics.set(
      item.token,

      {

        token:
          item.token,

        symbol:
          item.symbol,

        tradingSymbol:
          item.tradingSymbol,

        volume:
          currentVolume,

        volumeIncrease:
          increase,

        volumeIncreasePercent:
          percent,

        ltp:
          item.ltp,

        timestamp:
          Date.now()

      }

    );


    /*
      New interval starts
      from current cumulative volume.
    */

    intervalStartVolume.set(
      item.token,
      currentVolume
    );


    calculated++;

  }


  if (
    calculated > 0
  ) {

    volumeIntervalReady =
      true;

  }


  console.log(
    "📈 Volume interval calculated:",
    calculated,
    "stocks"
  );

}


/* =========================================================
   EVERY 60 SECONDS
========================================================= */

setInterval(
  () => {

    calculateVolumeInterval();

  },
  VOLUME_INTERVAL
);


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
        volumeData.size,

      volumeIntervalReady

    });

  }
);


/* =========================================================
   ANGEL ONE LOGIN
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


      /*
        Clean TOTP secret.
      */

      const cleanSecret =
        totpSecret
          .replace(
            /\s/g,
            ""
          )
          .toUpperCase();


      /*
        Generate current 6 digit TOTP.
      */

      const totp =
        await generate({

          secret:
            cleanSecret

        });


      /*
        SmartAPI.
      */

      const smartApi =
        new SmartAPI({

          api_key:
            apiKey

        });


      /*
        Login.
      */

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


      /*
        Save session.
      */

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
        F&O -> CASH universe.
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
        Futures OI -> CASH symbol
      */

      const data =
        raw
          .map(
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
                !mapping
              ) {

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
        raw
          .map(
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
                !mapping
              ) {

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
        First 60-second interval complete
        nahi hua to meaningful volume
        gain ranking possible nahi hai.
      */

      if (
        !volumeIntervalReady
      ) {

        return res.json({

          success: true,

          data: [],

          collecting: true,

          message:
            "Collecting first 60-second volume interval"

        });

      }


      /*
        Last completed 60-second
        volume metrics.
      */

      const result =
        Array.from(
          volumeMetrics.values()
        )
        .filter(
          item =>
            Number.isFinite(
              item.volumeIncrease
            ) &&
            item.volumeIncrease > 0
        )
        .map(
          item => ({

            tradingSymbol:
              item.symbol,

            symbol:
              item.symbol,

            symbolToken:
              item.token,

            /*
              Current cumulative NSE
              cash volume.
            */

            tradeVolume:
              item.volume,

            /*
              Volume traded during
              last completed 60 sec.
            */

            volumeChange:
              item.volumeIncrease,

            /*
              Actual percentage increase.
            */

            percentChange:
              item.volumeIncreasePercent,

            ltp:
              item.ltp,

            exchange:
              "NSE"

          })
        );


      /*
        Sort by volume increase %.

        Highest percentage increase
        first.

        If percentage is same,
        higher absolute volume increase
        wins.
      */

      result.sort(
        (a, b) => {

          const aPercent =
            Number(
              a.percentChange
            );


          const bPercent =
            Number(
              b.percentChange
            );


          if (
            Number.isFinite(
              aPercent
            ) &&
            Number.isFinite(
              bPercent
            ) &&
            aPercent !== bPercent
          ) {

            return (
              bPercent -
              aPercent
            );

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


      return res.json({

        success: true,

        data:
          result.slice(
            0,
            10
          ),

        intervalSeconds:
          60

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
