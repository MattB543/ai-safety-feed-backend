const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Parser } = require("json2csv");

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

const PORT = process.env.PORT || 8000;

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

// Helper function to build WHERE clause and parameters for list endpoints
function buildWhere({ search, sources }) {
  const clauses = [];
  const params = [];
  let i = 1;

  if (search) {
    clauses.push(`(
      title ILIKE $${i} OR
      array_to_string(authors,' ') ILIKE $${i} OR
      sentence_summary ILIKE $${i} OR
      paragraph_summary ILIKE $${i} OR
      array_to_string(topics,' ') ILIKE $${i} OR
      why_valuable ILIKE $${i} OR
      unique_aspects ILIKE $${i} OR
      author_credentials ILIKE $${i} OR
      cluster_tag ILIKE $${i}
    )`);
    params.push(`%${search}%`); // Add wildcards for partial match
    i++;
  }

  if (sources) {
    const list = sources
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean); // Split, trim, and remove empty strings
    if (list.length) {
      clauses.push(`source_type = ANY($${i}::text[])`); // Use ANY operator for array comparison
      params.push(list);
      i++;
    }
  }

  const whereSQL = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  return { whereSQL, params };
}

// Endpoint to fetch distinct source types
app.get("/api/sources", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT DISTINCT source_type FROM content ORDER BY source_type ASC"
    );
    res.json(result.rows.map((r) => r.source_type));
  } catch (err) {
    console.error("Error fetching sources:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// NEW endpoint → returns [{ source_type: 'EA Forum', count: 52 }, …]
app.get("/api/source-stats", async (req, res) => {
  try {
    const { search, sources, tags } = req.query;
    const { whereSQL: base, params } = buildWhere({ search, sources });

    // --- add tag filter (same pattern as /api/content) ---
    let tagSQL = "";
    if (tags) {
      const list = tags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      if (list.length) {
        tagSQL =
          (base ? " AND " : "WHERE ") +
          `
          LOWER(cluster_tag) = ANY($${params.length + 1}::text[])
        `;
        params.push(list);
      }
    }

    const sql = `
      SELECT source_type, COUNT(*)::int AS count
      FROM   content
      ${base} ${tagSQL}
      GROUP  BY source_type
      ORDER  BY source_type
    `;
    const result = await pool.query(sql, params);
    res.json(result.rows); // → [{source_type, count}, …]
  } catch (err) {
    console.error("Error fetching source stats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint to fetch distinct tags (cluster_tag + topics[]) with counts
app.get("/api/tags", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT LOWER(cluster_tag) AS tag,
             COUNT(*)::int      AS post_count
      FROM   content
      WHERE  cluster_tag IS NOT NULL
      GROUP  BY tag
      ORDER  BY post_count DESC, tag ASC
    `);

    return res.json(rows); // [{tag:"ai alignment", post_count:237}, …]
  } catch (err) {
    console.error("Error fetching tags:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint to fetch content from database
app.get("/api/content", async (req, res) => {
  const { search, sources, tags } = req.query;
  const { whereSQL: searchSourceWhereSQL, params: searchSourceParams } =
    buildWhere({ search, sources });

  const conditions = [];
  const finalParams = [...searchSourceParams]; // Start with params from buildWhere

  if (searchSourceWhereSQL) {
    conditions.push(searchSourceWhereSQL.replace(/^WHERE /, "")); // Add search/source conditions (remove WHERE)
  }

  let tagList = [];
  if (tags) {
    tagList = tags
      .split(",")
      .map((t) => t.trim().toLowerCase()) // Convert tags to lowercase
      .filter(Boolean);

    if (tagList.length > 0) {
      const nextParamIndex = finalParams.length + 1;
      conditions.push(`
        LOWER(cluster_tag) = ANY($${nextParamIndex}::text[])
      `);
      finalParams.push(tagList); // Add lowercased tagList to final parameters
    }
  }

  let query = "SELECT * FROM content";
  if (conditions.length > 0) {
    // Join conditions with AND, prepending WHERE
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY published_date DESC";

  try {
    const result = await pool.query(query, finalParams);
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("Error fetching content:", err);
    console.error("Faulty Query:", query); // Log the query on error
    console.error("Parameters:", finalParams); // Log the parameters on error
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/content/export
 * Streams every row of public.content as a downloadable CSV
 */
app.get("/api/content/export", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM content ORDER BY id"); // grab everything
    const csv = new Parser().parse(rows); // → string
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="content-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`
    );
    return res.status(200).send(csv);
  } catch (err) {
    console.error("CSV export error:", err);
    return res.status(500).json({ error: "Failed to export CSV" });
  }
});

// Start the server and listen on the defined port
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
