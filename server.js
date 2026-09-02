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
   SERVER STATUS
========================= */

app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    message: "F&O Live Scanner server is running",
    timestamp: new Date().toISOString()
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

    /* Remove spaces from TOTP secret */
    const cleanSecret =
      totpSecret
        .replace(/\s/g, "")
        .toUpperCase();

    /* Generate current 6 digit TOTP */
    const totp = await generate({
      secret: cleanSecret
    });

    console.log("TOTP generated");

    /* Create Angel One API object */

    const smartApi = new SmartAPI({
      api_key: apiKey
    });

    /* Angel One login */

    const session = await smartApi.generateSession(
      clientCode,
      mpin,
      totp
    );

    console.log("Angel One response received");

    if (!session || !session.data) {

      console.log(
        "Angel One response:",
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

    /* Store session in server memory */

    angelSession = {

      smartApi: smartApi,

      clientCode: clientCode,

      authToken:
        session.data.jwtToken,

      refreshToken:
        session.data.refreshToken,

      feedToken:
        session.data.feedToken

    };

    console.log(
      "🟢 ANGEL ONE LOGIN SUCCESSFUL"
    );

    return res.json({

      success: true,

      message:
        "Angel One connected successfully"

    });

  }

  catch (error) {

    console.error(
      "Angel login error:",
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
   FRONTEND
========================= */

app.get("/{*splat}", (req, res) => {

  res.sendFile(
    __dirname + "/public/index.html"
  );

});

/* =========================
   START SERVER
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
