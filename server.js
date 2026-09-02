const express = require("express");
const cors = require("cors");
const { SmartAPI } = require("smartapi-javascript");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    message: "F&O Live Scanner server is running"
  });
});

// ANGEL ONE LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const { apiKey, clientCode, mpin, totp } = req.body;

    if (!apiKey || !clientCode || !mpin || !totp) {
      return res.status(400).json({
        success: false,
        message: "All login fields are required"
      });
    }

    const smartApi = new SmartAPI({
      api_key: apiKey
    });

    const session = await smartApi.generateSession(
      clientCode,
      mpin,
      totp
    );

    if (!session || !session.data) {
      return res.status(401).json({
        success: false,
        message: "Angel One login failed"
      });
    }

    // IMPORTANT:
    // Tokens are NOT returned to the webpage.
    global.angelSession = {
      smartApi,
      clientCode,
      apiKey,
      authToken: session.data.jwtToken,
      refreshToken: session.data.refreshToken,
      feedToken: session.data.feedToken
    };

    console.log("Angel One login successful");

    res.json({
      success: true,
      message: "Angel One connected successfully"
    });

  } catch (error) {
    console.error("Angel login error:", error.message);

    res.status(500).json({
      success: false,
      message: error.message || "Angel One login failed"
    });
  }
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
