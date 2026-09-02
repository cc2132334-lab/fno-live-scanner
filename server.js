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
   VOLUME WEBSOCKET
========================================================= */

let volumeSocket = null;

let volumeInstruments = new Map();

let volumeData = new Map();

let volumeBaseline = new Map();

let volumeReady = false;

let volumeSocketStarted = false;


/*
  Volume snapshot interval.

  Har 60 second par previous volume
  aur current volume compare hoga.
*/

const VOLUME_INTERVAL =
  60 * 1000;


/* =========================================================
   SCRIP MASTER URL
========================================================= */

const SCRIP_MASTER_URL =
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";


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

            reject(
              new Error(
                "Scrip master download failed. HTTP " +
                response.statusCode
              )
            );

            response.resume();

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
   DATE HELPERS
========================================================= */

function normalizeDate(value) {

  if (!value) {
    return null;
  }


  const date =
    new Date(value);


  if (
    Number.isNaN(
      date.getTime()
    )
  ) {

    return null;

  }


  return date;

}


/* =========================================================
   LOAD F&O FUTURES
========================================================= */

async function loadFuturesInstruments() {

  console.log(
    "📥 Downloading Angel One scrip master..."
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


  const today =
    new Date();


  today.setHours(
    0,
    0,
    0,
    0
  );


  /*
    Pehle sirf NFO futures.
  */

  const futures =
    master.filter(
      (item) => {

        const exchange =
          String(
            item.exch_seg || ""
          ).toUpperCase();


        const instrumentType =
          String(
            item.instrumenttype || ""
          ).toUpperCase();


        const symbol =
          String(
            item.symbol || ""
          ).toUpperCase();


        const expiry =
          normalizeDate(
            item.expiry
          );


        if (
          exchange !== "NFO"
        ) {

          return false;

        }


        /*
          Stock futures + index futures
        */

        const isFuture =
          instrumentType === "FUTSTK" ||
          instrumentType === "FUTIDX" ||
          symbol.endsWith("FUT");


        if (!isFuture) {

          return false;

        }


        if (!expiry) {

          return false;

        }


        expiry.setHours(
          0,
          0,
          0,
          0
        );


        if (
          expiry < today
        ) {

          return false;

        }


        return true;

      }
    );


  /*
    Har underlying ka nearest expiry
    choose karenge.
  */

  const nearest =
    new Map();


  for (
    const item of futures
  ) {

    const symbol =
      String(
        item.symbol || ""
      );


    /*
      Example:
      HEROMOTOCOR29SEP26FUT

      Expiry remove karke underlying
      identify karne ki koshish.
    */

    const expiry =
      normalizeDate(
        item.expiry
      );


    if (!expiry) {
      continue;
    }


    /*
      Scrip master me name/expiry ko
      primary grouping ke liye use karenge.
    */

    const underlying =
      String(
        item.name ||
        item.symbol ||
        ""
      )
        .toUpperCase()
        .trim();


    if (!underlying) {
      continue;
    }


    const existing =
      nearest.get(
        underlying
      );


    if (
      !existing ||
      expiry < existing.expiry
    ) {

      nearest.set(
        underlying,
        {
          ...item,
          expiry
        }
      );

    }

  }


  const selected =
    Array.from(
      nearest.values()
    );


  /*
    Kuch cases me name grouping
    perfect nahi hoti.

    Isliye token/symbol unique rakho.
  */

  const unique =
    new Map();


  for (
    const item of selected
  ) {

    const token =
      String(
        item.token || ""
      );


    if (!token) {
      continue;
    }


    unique.set(
      token,
      item
    );

  }


  console.log(
    "📊 F&O futures selected:",
    unique.size
  );


  return Array.from(
    unique.values()
  );

}


/* =========================================================
   START VOLUME WEBSOCKET
========================================================= */

async function startVolumeWebSocket() {

  if (
    !angelSession
  ) {

    console.log(
      "⚠️ Cannot start volume socket: not logged in"
    );

    return;

  }


  /*
    Existing socket close.
  */

  if (
    volumeSocket
  ) {

    try {

      volumeSocket.close();

    } catch (error) {

      console.log(
        "Socket close error:",
        error.message
      );

    }

  }


  volumeSocket =
    null;

  volumeReady =
    false;

  volumeSocketStarted =
    false;


  try {

    const instruments =
      await loadFuturesInstruments();


    if (
      !instruments.length
    ) {

      throw new Error(
        "No F&O futures instruments found"
      );

    }


    volumeInstruments.clear();

    volumeData.clear();

    volumeBaseline.clear();


    /*
      Token mapping
    */

    const tokens =
      [];


    for (
      const item of instruments
    ) {

      const token =
        String(
          item.token || ""
        );


      if (!token) {
        continue;
      }


      volumeInstruments.set(
        token,
        {
          token,
          symbol:
            item.symbol ||
            item.tradingsymbol ||
            item.name ||
            token,

          name:
            item.name ||
            "",

          expiry:
            item.expiry ||
            "",

          lotsize:
            item.lotsize ||
            ""
        }
      );


      tokens.push(
        token
      );

    }


    /*
      WebSocket V2 max subscription
      is 1000 tokens per connection.

      F&O futures normally fit below this,
      but safe chunks bhi bana rahe hain.
    */

    const tokenChunks =
      [];


    for (
      let i = 0;
      i < tokens.length;
      i += 1000
    ) {

      tokenChunks.push(
        tokens.slice(
          i,
          i + 1000
        )
      );

    }


    /*
      Is project ke current setup me
      ek primary WebSocket use karenge.

      Agar tokens > 1000 hue to first
      1000 se start karenge.
    */

    const firstChunk =
      tokenChunks[0] || [];


    console.log(
      "🔌 Starting Angel One WebSocket..."
    );

    console.log(
      "📡 Subscribing tokens:",
      firstChunk.length
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
      Tick event
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


          const instrument =
            volumeInstruments.get(
              token
            );


          if (!instrument) {
            return;
          }


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


          /*
            Save live volume.
          */

          const old =
            volumeData.get(
              token
            );


          volumeData.set(
            token,
            {

              token,

              symbol:
                instrument.symbol,

              name:
                instrument.name,

              volume,

              price:
                Number(
                  tick.last_traded_price ||
                  0
                ) / 100,

              lastTradedQuantity:
                Number(
                  tick.last_traded_quantity ||
                  0
                ),

              timestamp:
                Date.now(),

              previousVolume:
                old?.volume ??
                null

            }
          );


          /*
            First volume becomes baseline.
          */

          if (
            !volumeBaseline.has(
              token
            )
          ) {

            volumeBaseline.set(
              token,
              {

                volume,

                timestamp:
                  Date.now()

              }
            );

          }

        } catch (error) {

          console.error(
            "VOLUME TICK ERROR:",
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
      Quote mode = 2

      NSE_FO = 2

      Action Subscribe = 1
    */

    volumeSocket.fetchData({

      correlationID:
        "fno-volume-scanner",

      action: 1,

      mode: 2,

      exchangeType: 2,

      tokens:
        firstChunk

    });


    volumeReady =
      true;

    volumeSocketStarted =
      true;


    console.log(
      "🟢 VOLUME WEBSOCKET CONNECTED"
    );


  } catch (error) {

    console.error(
      "❌ VOLUME WEBSOCKET ERROR:",
      error?.message ||
      error
    );


    volumeReady =
      false;

  }

}


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

        /*
          Safety start.
        */

        await startVolumeWebSocket();

      }


      const now =
        Date.now();


      const result =
        [];


      for (
        const item of
        volumeData.values()
      ) {

        if (
          !item.volume ||
          item.volume <= 0
        ) {

          continue;

        }


        const baseline =
          volumeBaseline.get(
            item.token
          );


        let volumeChange =
          null;

        let percentChange =
          null;


        if (
          baseline &&
          item.volume >= baseline.volume
        ) {

          volumeChange =
            item.volume -
            baseline.volume;


          if (
            baseline.volume > 0
          ) {

            percentChange =
              (
                volumeChange /
                baseline.volume
              ) * 100;

          }

        }


        result.push({

          tradingSymbol:
            item.symbol,

          symbolToken:
            item.token,

          tradeVolume:
            item.volume,

          volumeChange,

          percentChange,

          ltp:
            item.price,

          lastTradeQty:
            item.lastTradedQuantity,

          timestamp:
            item.timestamp

        });

      }


      /*
        Actual volume increase ko
        priority.

        Agar increase available nahi hai,
        cumulative traded volume use hoga.
      */

      result.sort(
        (a, b) => {

          const aChange =
            Number(
              a.volumeChange
            );


          const bChange =
            Number(
              b.volumeChange
            );


          if (
            Number.isFinite(aChange) &&
            Number.isFinite(bChange) &&
            aChange !== bChange
          ) {

            return bChange - aChange;

          }


          return (
            Number(
              b.tradeVolume
            ) -
            Number(
              a.tradeVolume
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
          )

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
   VOLUME BASELINE UPDATE
========================================================= */

setInterval(
  () => {

    if (
      !volumeReady
    ) {

      return;

    }


    /*
      Current volume ko new baseline
      bana do.

      Isse next 60 sec ka volume
      increase calculate hoga.
    */

    for (
      const item of
      volumeData.values()
    ) {

      if (
        Number.isFinite(
          item.volume
        )
      ) {

        volumeBaseline.set(
          item.token,
          {

            volume:
              item.volume,

            timestamp:
              Date.now()

          }
        );

      }

    }


    console.log(
      "🔄 Volume baseline updated"
    );


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
        "F&O Live Scanner server is running",

      angelConnected:
        !!angelSession,

      volumeSocket:
        volumeReady,

      instruments:
        volumeInstruments.size,

      liveVolumeSymbols:
        volumeData.size

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
        SmartAPI object.
      */

      const smartApi =
        new SmartAPI({

          api_key:
            apiKey

        });


      /*
        Angel One login.
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
        Volume WebSocket start.
      */

      try {

        await startVolumeWebSocket();

      } catch (volumeError) {

        console.error(
          "Volume startup error:",
          volumeError.message
        );

      }


      return res.json({

        success: true,

        message:
          "Angel One connected successfully",

        volumeSocket:
          volumeReady

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


      const result =
        await angelSession
          .smartApi
          .gainersLosers({

            datatype:
              "PercOIGainers",

            expirytype:
              "NEAR"

          });


      console.log(
        "OI GAINERS RESPONSE:",
        result
      );


      return res.json({

        success: true,

        data:
          result?.data ||
          result

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


      const result =
        await angelSession
          .smartApi
          .gainersLosers({

            datatype:
              "PercOILosers",

            expirytype:
              "NEAR"

          });


      console.log(
        "OI LOSERS RESPONSE:",
        result
      );


      return res.json({

        success: true,

        data:
          result?.data ||
          result

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
