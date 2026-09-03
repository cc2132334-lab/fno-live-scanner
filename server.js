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

const SCRIP_MASTER_URL =
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";

let scripMasterLoaded = false;


/* =====================================================
   F&O CASH UNIVERSE
===================================================== */

const cashStocks = new Map();
const futureToCash = new Map();


/* =====================================================
   VOLUME WEBSOCKET
===================================================== */

let volumeSocket = null;
let volumeReady = false;
let volumeSocketStarted = false;


/*
  Current live volume for each NSE cash stock
*/
const volumeData = new Map();


/*
  Recent volume snapshots.

  token => [
    {
      time,
      volume
    }
  ]
*/
const volumeHistory = new Map();


/*
  We compare approximately the last 30 seconds.

  This is intentionally shorter than the previous
  60-second requirement so the scanner starts showing
  results much faster.
*/
const VOLUME_LOOKBACK_MS = 30 * 1000;


/* =====================================================
   DOWNLOAD SCRIP MASTER
===================================================== */

function downloadScripMaster() {

  return new Promise((resolve, reject) => {

    https.get(
      SCRIP_MASTER_URL,
      {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      },
      response => {

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


/* =====================================================
   SYMBOL CLEANER
===================================================== */

function cleanSymbol(value) {

  if (!value) {
    return "";
  }

  return String(value)
    .toUpperCase()
    .trim()
    .replace(/-EQ$/, "");

}


/* =====================================================
   LOAD F&O STOCK UNIVERSE
===================================================== */

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


  /*
    First create NSE CASH map.

    Example:

    HDFCBANK-EQ
    RELIANCE-EQ
    SBIN-EQ

    becomes:

    HDFCBANK
    RELIANCE
    SBIN
  */

  const nseCash =
    new Map();


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


  /*
    Now find F&O stock futures.

    FUTSTK = Stock Futures

    We use their underlying name only
    to identify which CASH stocks are F&O eligible.
  */

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


    if (
      instrumentType !==
      "FUTSTK"
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
      Match F&O underlying with NSE cash symbol.
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


  /* =================================================
     FUTURES -> CASH MAPPING
  ================================================= */

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


  /* =================================================
     CASH STOCK MAP
  ================================================= */

  cashStocks.clear();


  for (
    const underlying
    of fnoUnderlyings
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


  scripMasterLoaded = true;


  console.log(
    "🟢 F&O -> CASH mapping ready"
  );

  console.log(
    "💰 F&O eligible CASH stocks:",
    cashStocks.size
  );

}


/* =====================================================
   START CASH VOLUME WEBSOCKET
===================================================== */

async function startVolumeWebSocket() {

  if (!angelSession) {
    return;
  }


  try {

    /*
      Close old socket if any.
    */

    if (volumeSocket) {

      try {
        volumeSocket.close();
      } catch (_) {}

    }


    volumeSocket = null;

    volumeReady = false;

    volumeSocketStarted = false;


    /*
      Clear old data after new login.
    */

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
      Angel One WebSocket subscription.
      Keep maximum 1000 tokens.
    */

    const subscribeTokens =
      tokens.slice(0, 1000);


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


    /* =================================================
       LIVE TICK
    ================================================= */

    volumeSocket.on(
      "tick",
      tick => {

        try {

          if (!tick) {
            return;
          }


          const token =
            String(
              tick.token || ""
            ).replace(
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
            Angel One gives traded volume
            for the day.

            Example:

            12,50,000
            12,53,400
            12,58,900

            We calculate the increase.
          */

          const volume =
            Number(
              tick.vol_traded
            );


          if (
            !Number.isFinite(volume)
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


          /*
            Current data
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
                now
            }
          );


          /*
            History
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
            Add snapshot whenever
            volume changes.
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
            Keep last 2 minutes.
          */

          const cutoff =
            now -
            2 * 60 * 1000;


          while (
            history.length &&
            history[0].time <
              cutoff
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
      Connect
    */

    await volumeSocket.connect();


    /*
      NSE CASH
      exchangeType = 1

      mode = 3
      SnapQuote
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


    volumeReady = true;

    volumeSocketStarted = true;


    console.log(
      "🟢 NSE CASH VOLUME WEBSOCKET CONNECTED"
    );

  } catch (error) {

    console.error(
      "❌ CASH WEBSOCKET ERROR:",
      error?.message ||
      error
    );

    volumeReady = false;

    volumeSocketStarted = false;

  }

}


/* =====================================================
   FIND OLD VOLUME
===================================================== */

function getOldVolume(
  history,
  now
) {

  if (
    !history ||
    !history.length
  ) {

    return null;

  }


  const target =
    now -
    VOLUME_LOOKBACK_MS;


  let closest = null;


  /*
    Find the latest sample that is
    older than our lookback.
  */

  for (
    let i = 0;
    i < history.length;
    i++
  ) {

    if (
      history[i].time <= target
    ) {

      closest =
        history[i];

    } else {

      break;

    }

  }


  /*
    If exact 30 sec history isn't
    available, use the oldest available
    sample.

    This prevents blank results.
  */

  if (!closest) {

    closest =
      history[0] ||
      null;

  }


  return closest;

}


/* =====================================================
   VOLUME GAINERS
===================================================== */

function getVolumeGainers() {

  const now =
    Date.now();


  const result = [];


  for (
    const item
    of volumeData.values()
  ) {

    const history =
      volumeHistory.get(
        item.token
      );


    if (
      !history ||
      !history.length
    ) {

      continue;

    }


    const oldSample =
      getOldVolume(
        history,
        now
      );


    if (!oldSample) {
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


    /*
      Actual volume increase.
    */

    const increase =
      Math.max(
        0,
        currentVolume -
        oldVolume
      );


    /*
      We only want stocks whose
      volume has actually increased.
    */

    if (increase <= 0) {
      continue;
    }


    let percent = 0;


    if (oldVolume > 0) {

      percent =
        (
          increase /
          oldVolume
        ) * 100;

    }


    result.push({

      /*
        CASH SYMBOL ONLY
      */

      symbol:
        item.symbol,

      tradingSymbol:
        item.symbol,

      symbolToken:
        item.token,


      /*
        Current NSE cash volume
      */

      tradeVolume:
        currentVolume,


      /*
        Volume added during
        comparison period
      */

      volumeChange:
        increase,


      /*
        Percentage increase
      */

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
    Primary ranking:
    percentage volume increase

    Secondary:
    absolute volume increase
  */

  result.sort(
    (a, b) => {

      const percentageDifference =
        Number(
          b.percentChange
        ) -
        Number(
          a.percentChange
        );


      if (
        percentageDifference !== 0
      ) {

        return percentageDifference;

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


/* =====================================================
   STATUS
===================================================== */

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      success: true,

      angelConnected:
        !!angelSession,

      scripMasterLoaded:
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


/* =====================================================
   LOGIN
===================================================== */

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

        return res.status(400).json({

          success: false,

          message:
            "Please fill all fields"

        });

      }


      const cleanSecret =
        totpSecret
          .replace(/\s/g, "")
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


        return res.status(401).json({

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
        Load F&O universe
      */

      await loadFNOUniverse();


      /*
        Start cash volume WebSocket
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


      return res.status(500).json({

        success: false,

        message:
          error?.message ||
          "Angel One login failed"

      });

    }

  }
);


/* =====================================================
   OI GAINERS
===================================================== */

app.get(
  "/api/oi-gainers",
  async (req, res) => {

    try {

      if (!angelSession) {

        return res.status(401).json({

          success: false,

          message:
            "Angel One is not connected"

        });

      }


      if (!scripMasterLoaded) {

        await loadFNOUniverse();

      }


      const result =
        await angelSession.smartApi.gainersLosers({

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
          .map(item => {

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

              /*
                CASH SYMBOL DISPLAY
              */

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

          })
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


      return res.status(500).json({

        success: false,

        message:
          error?.message ||
          "Unable to fetch OI gainers"

      });

    }

  }
);


/* =====================================================
   OI LOSERS
===================================================== */

app.get(
  "/api/oi-losers",
  async (req, res) => {

    try {

      if (!angelSession) {

        return res.status(401).json({

          success: false,

          message:
            "Angel One is not connected"

        });

      }


      if (!scripMasterLoaded) {

        await loadFNOUniverse();

      }


      const result =
        await angelSession.smartApi.gainersLosers({

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
          .map(item => {

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

          })
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


      return res.status(500).json({

        success: false,

        message:
          error?.message ||
          "Unable to fetch OI losers"

      });

    }

  }
);


/* =====================================================
   VOLUME GAINERS API
===================================================== */

app.get(
  "/api/volume-gainers",
  async (req, res) => {

    try {

      if (!angelSession) {

        return res.status(401).json({

          success: false,

          message:
            "Angel One is not connected"

        });

      }


      /*
        If socket somehow stopped,
        restart it.
      */

      if (
        !volumeSocketStarted
      ) {

        await startVolumeWebSocket();

      }


      const data =
        getVolumeGainers();


      return res.json({

        success: true,

        data,

        /*
          Comparison window
        */

        intervalSeconds:
          30,

        /*
          True only when we have
          no usable gainers yet.
        */

        collecting:
          data.length === 0,

        /*
          Useful debugging info
        */

        liveStocks:
          volumeData.size,

        historyStocks:
          volumeHistory.size

      });


    } catch (error) {

      console.error(
        "VOLUME GAINERS ERROR:",
        error?.message ||
        error
      );


      return res.status(500).json({

        success: false,

        message:
          error?.message ||
          "Unable to fetch volume gainers"

      });

    }

  }
);


/* =====================================================
   FRONTEND
===================================================== */

app.get(
  "/{*splat}",
  (req, res) => {

    res.sendFile(
      __dirname +
      "/public/index.html"
    );

  }
);


/* =====================================================
   START SERVER
===================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Server running on port ${PORT}`
    );

  }
);
