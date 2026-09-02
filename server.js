const express = require("express");
const cors = require("cors");
const { SmartAPI } = require("smartapi-javascript");
const { generate } = require("otplib");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

let angelSession = null;

/* =========================
   STATUS
========================= */

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "F&O Live Scanner server is running",
    angelConnected: !!angelSession
  });
});


/* =========================
   ANGEL ONE LOGIN
========================= */

app.post("/api/login", async (req, res) => {

  try {

    const {
      apiKey,
      clientCode,
      mpin,
      totpSecret
    } = req.body;

    if (!apiKey || !clientCode || !mpin || !totpSecret) {
      return res.status(400).json({
        success: false,
        message: "Please fill all fields"
      });
    }

    const cleanSecret = totpSecret
      .replace(/\s/g, "")
      .toUpperCase();

    const totp = await generate({
      secret: cleanSecret
    });

    const smartApi = new SmartAPI({
      api_key: apiKey
    });

    const session = await smartApi.generateSession(
      clientCode,
      mpin,
      totp
    );

    if (!session || !session.data) {

      console.log("LOGIN RESPONSE:", session);

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
      authToken: session.data.jwtToken,
      refreshToken: session.data.refreshToken,
      feedToken: session.data.feedToken
    };

    console.log("🟢 ANGEL ONE CONNECTED");

    return res.json({
      success: true,
      message: "Angel One connected successfully"
    });

  } catch (error) {

    console.error(
      "LOGIN ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Angel One login failed"
    });
  }
});


/* =========================
   OI GAINERS
========================= */

app.get("/api/oi-gainers", async (req, res) => {

  try {

    if (!angelSession) {
      return res.status(401).json({
        success: false,
        message: "Angel One is not connected"
      });
    }

    const result =
      await angelSession.smartApi.gainersLosers({
        datatype: "PercOIGainers",
        expirytype: "NEAR"
      });

    console.log(
      "OI GAINERS RESPONSE:",
      result
    );

    return res.json({
      success: true,
      data: result?.data || result
    });

  } catch (error) {

    console.error(
      "OI GAINERS ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Unable to fetch OI gainers"
    });
  }
});


/* =========================
   OI LOSERS
========================= */

app.get("/api/oi-losers", async (req, res) => {

  try {

    if (!angelSession) {
      return res.status(401).json({
        success: false,
        message: "Angel One is not connected"
      });
    }

    const result =
      await angelSession.smartApi.gainersLosers({
        datatype: "PercOILosers",
        expirytype: "NEAR"
      });

    console.log(
      "OI LOSERS RESPONSE:",
      result
    );

    return res.json({
      success: true,
      data: result?.data || result
    });

  } catch (error) {

    console.error(
      "OI LOSERS ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Unable to fetch OI losers"
    });
  }
});


/* =========================
   FRONTEND
========================= */

app.get("/{*splat}", (req, res) => {

  res.sendFile(
    __dirname + "/public/index.html"
  );

});


/* =========================
   SERVER
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }
);
