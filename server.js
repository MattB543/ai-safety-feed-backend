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

// Add error handler for the pool
pool.on("error", (err) => {
  console.error("Unexpected error on database client", err);
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
  const searchTerm = req.query.search;
  let query = "SELECT * FROM content";
  const queryParams = [];

  if (searchTerm) {
    // Basic search across multiple fields
    // NOTE: Consider PostgreSQL Full-Text Search for better performance/relevance later
    query += ` WHERE title ILIKE $1
               OR array_to_string(authors, ' ') ILIKE $1
               OR sentence_summary ILIKE $1
               OR paragraph_summary ILIKE $1
               OR array_to_string(topics, ' ') ILIKE $1
               OR why_valuable ILIKE $1
               OR unique_aspects ILIKE $1
               OR author_credentials ILIKE $1`;
    queryParams.push(`%${searchTerm}%`); // Add wildcards for partial match
  }

  // Always order by date, regardless of search
  query += " ORDER BY published_date DESC"; // Keep existing sort

  try {
    // Use parameterized query
    const result = await pool.query(query, queryParams);
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
