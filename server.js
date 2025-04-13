const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

app.use(helmet());

// Apply rate limiting to all requests
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 100, // Limit each IP to 100 requests per `windowMs`
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: "Too many requests from this IP, please try again after 10 minutes",
});

// Apply the rate limiting middleware to all requests
app.use(limiter);

const PORT = process.env.PORT || 3000;

// Database setup
const pool = new Pool({
  connectionString: process.env.SUPABASE_URL,
  // ssl: { rejectUnauthorized: false } // Uncomment if needed
});

// Middleware to parse JSON
app.use(express.json());

// Enable CORS
app.use(cors());

// Define the /health endpoint
app.get("/health", (req, res) => {
  res.sendStatus(200);
});

// Endpoint to fetch content from database
app.get("/api/content", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM content");
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching content:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Start the server and listen on the defined port
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
