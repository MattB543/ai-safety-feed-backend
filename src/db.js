// The Postgres pool. Creating it doesn't connect; the first query does, so
// tests can require the app and stub pool.query without a database.

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.PG_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  // Fail fast instead of queueing forever if every connection is busy.
  connectionTimeoutMillis: 10000,
});

// Add error handler for the pool
pool.on("error", (err) => {
  // Add more detail to the pool error logging
  console.error("Unexpected error on idle database client", err.message);
  console.error("Error Code:", err.code); // Log the specific error code if available
  // console.error(err.stack); // Uncomment for full stack trace if needed
});

// Startup connection test (called from server.js; optional but helpful)
function checkConnection() {
  console.log("Attempting DB connection...");
  console.log(
    "Using DB URL from env:",
    process.env.PG_URL ? "Loaded" : "MISSING or undefined!"
  ); // Check if the env var is loaded

  pool.connect((err, client) => {
    if (err) {
      console.error("FATAL: Initial database connection failed:", err.message);
      console.error("Error Code:", err.code);
      // console.error(err.stack); // Uncomment for full stack trace
      // Consider exiting if the initial connection fails
      // process.exit(1);
    } else {
      console.log("Initial database connection successful!");
      client.release(); // Release the client back to the pool
    }
  });
}

module.exports = { pool, checkConnection };
