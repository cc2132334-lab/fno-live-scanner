const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    message: "F&O Live Scanner server is running",
    timestamp: new Date().toISOString()
  });
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
