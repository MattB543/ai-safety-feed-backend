const express = require("express");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

const PORT = process.env.PORT || 3000;

// Database setup
const pool = new Pool({
  connectionString: process.env.SUPABASE_URL,
  // ssl: { rejectUnauthorized: false } // Uncomment if needed
});

// Middleware to parse JSON
app.use(express.json());

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
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`Content API available at http://localhost:${PORT}/api/content`);
});
