const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Parser } = require("json2csv");
const fs = require("fs");

const { GoogleGenAI } = require("@google/genai");

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = "gemini-2.5-flash-preview-04-17";

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
console.log("Attempting DB connection...");
console.log(
  "Using DB URL from env:",
  process.env.PG_URL ? "Loaded" : "MISSING or undefined!"
); // Check if the env var is loaded

let caCert;
const caPath = __dirname + "/ca-certificate.crt";
caCert = fs.readFileSync(caPath).toString();

// Now create the pool using the loaded cert
const pool = new Pool({
  connectionString: process.env.PG_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Add error handler for the pool
pool.on("error", (err) => {
  // Add more detail to the pool error logging
  console.error("Unexpected error on idle database client", err.message);
  console.error("Error Code:", err.code); // Log the specific error code if available
  // console.error(err.stack); // Uncomment for full stack trace if needed
});

// Try a simple connection test right after pool creation (optional but helpful)
pool.connect((err, client, release) => {
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

// Helper function to build the prompt for reranking candidates
function buildRerankPrompt(ref, candidates) {
  const refBlock = `REFERENCE ARTICLE
  ID: ${ref.id}
  Title: ${ref.title}
  Summary: ${ref.sentence_summary || ""}
  Main points: ${ref.paragraph_summary || ""}
  Key implication: ${ref.key_implication || ""}`.trim();

  const candBlocks = candidates
    .map((c, i) =>
      `---
  ID: ${c.id}
  Title: ${c.title}
  Summary: ${c.sentence_summary || ""}
  Main points: ${c.paragraph_summary || ""}
  Key implication: ${c.key_implication || ""}`.trim()
    )
    .join("\n\n");

  return `
  ${refBlock}

  ${candBlocks}

  TASK
  Based on semantic similarity (considering topics, summaries, implications, etc.), return a JSON array only with 10 to 15 candidate IDs, ordered most similar to least similar when compared to the REFERENCE ARTICLE.
  Ensure the output is only the JSON array (e.g., ["id1", "id2", ...]) with no other text, commentary, or formatting like back-ticks.
  `.trim();
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
  const { search, sources, tags, novelty_bucket, order_by } = req.query;
  const limit = parseInt(req.query.limit) || 50; // Default limit to 50
  const offset = parseInt(req.query.offset) || 0; // Default offset to 0

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

  // Add novelty_bucket filter if provided
  if (novelty_bucket) {
    const bucket = parseInt(novelty_bucket);
    let minScore = 0;
    let maxScore = 100;
    switch (bucket) {
      case 2:
        minScore = 21;
        maxScore = 40;
        break;
      case 3:
        minScore = 41;
        maxScore = 70;
        break;
      case 4:
        minScore = 71;
        maxScore = 80;
        break;
      case 5:
        minScore = 81;
        maxScore = 100;
        break;
      // case 1 and default: minScore = 0, maxScore = 20
      case 1:
        minScore = 0;
        maxScore = 20;
        break;
    }

    // Only add the condition if minScore > 0
    if (minScore > 0) {
      conditions.push(`novelty_score >= $${finalParams.length + 1}`);
      finalParams.push(minScore);
    }
  }

  let query = `SELECT
    id, title, sentence_summary, paragraph_summary, key_implication,
    novelty_score, novelty_note,
    image_url, source_url, source_type,
    authors, topics, cluster_tag, published_date
  FROM content`;
  if (conditions.length > 0) {
    // Join conditions with AND, prepending WHERE
    query += " WHERE " + conditions.join(" AND "); // filters here
  }

  // Determine the ORDER BY clause
  if (order_by === "random") {
    query += " ORDER BY RANDOM()"; // <-- Add random ordering
  } else {
    query += " ORDER BY published_date DESC"; // Default ordering
  }

  // Add LIMIT and OFFSET for pagination
  const limitParamIndex = finalParams.length + 1;
  query += ` LIMIT $${limitParamIndex}`;
  finalParams.push(limit);

  const offsetParamIndex = finalParams.length + 1;
  query += ` OFFSET $${offsetParamIndex}`;
  finalParams.push(offset);

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

// NEW endpoint to fetch multiple posts by a list of IDs
app.get("/api/content/by-ids", async (req, res) => {
  const { ids } = req.query;

  if (!ids) {
    return res.status(400).json({ error: "Missing 'ids' query parameter" });
  }

  // Split the comma-separated string and convert to numbers, filtering out invalid entries
  const idList = ids
    .split(",")
    .map((id) => parseInt(id.trim()))
    .filter((id) => !isNaN(id) && id > 0);

  if (idList.length === 0) {
    // Handle cases where no valid IDs were provided after filtering
    return res
      .status(400)
      .json({ error: "No valid IDs provided in 'ids' query parameter" });
  }

  try {
    // Use ANY operator for efficient querying with an array of IDs
    const query = "SELECT * FROM content WHERE id = ANY($1::int[])";
    const { rows } = await pool.query(query, [idList]);

    // Return the found posts. It might be an empty array if none of the IDs matched.
    res.json(rows);
  } catch (err) {
    console.error("Error fetching content by IDs:", err);
    console.error("Query Parameters (parsed):", idList); // Log the parsed IDs
    res.status(500).json({ error: "Internal server error" });
  }
});

// NEW endpoint to fetch a single post by ID
// NOTE: This must come *after* /api/content/by-ids to avoid conflict
app.get("/api/content/:id", async (req, res) => {
  try {
    const {
      rows: [post],
    } = await pool.query("SELECT * FROM content WHERE id=$1", [req.params.id]);
    if (post) {
      res.json(post);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    console.error(`Error fetching content with ID ${req.params.id}:`, err);
    res.status(500).json({ error: "Internal server error" });
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

// Helper function to find vector similar candidates
async function findVectorSimilarCandidates(id, k) {
  console.log(`[findVectorSimilarCandidates/${id}] Fetching reference post...`);
  const {
    rows: [ref],
  } = await pool.query(
    "SELECT * FROM content WHERE id=$1 AND embedding_short IS NOT NULL AND embedding_full IS NOT NULL",
    [id]
  );
  if (!ref) {
    console.log(
      `[findVectorSimilarCandidates/${id}] Reference post not found.`
    );
    return { ref: null, candidates: [], error: "Post not found", status: 404 };
  }
  console.log(
    `[findVectorSimilarCandidates/${id}] Found reference post: ${ref.title}`
  );

  // pgvector nearest-neighbour union
  console.log(
    `[findVectorSimilarCandidates/${id}] Fetching ${k} candidates via vector search...`
  );
  const { rows: cands } = await pool.query(
    `
      (SELECT *, embedding_short <=> $1 AS dist
        FROM content
        WHERE id <> $3
    ORDER BY embedding_short <=> $1
        LIMIT $2)
      UNION
      (SELECT *, embedding_full  <=> $4 AS dist
        FROM content
        WHERE id <> $3
    ORDER BY embedding_full  <=> $4
        LIMIT $2)
      `,
    [ref.embedding_short, k, id, ref.embedding_full]
  );
  console.log(
    `[findVectorSimilarCandidates/${id}] Found ${cands.length} candidates.`
  );

  // Deduplicate candidates based on ID, keeping the first occurrence
  const uniqueCandsMap = new Map();
  cands.forEach((cand) => {
    if (!uniqueCandsMap.has(cand.id)) {
      uniqueCandsMap.set(cand.id, cand);
    }
  });
  const uniqueCands = Array.from(uniqueCandsMap.values());
  console.log(
    `[findVectorSimilarCandidates/${id}] Deduplicated to ${uniqueCands.length} unique candidates.`
  );

  return { ref, candidates: uniqueCands, error: null, status: 200 };
}

// --- Endpoint for Vector-Only Similar Posts ---
app.get("/api/similar/:id/vector", async (req, res) => {
  const { id } = req.params;
  const k = 20; // Initial candidates to fetch
  const n = 20; // Final results to return
  console.log(`[similar/${id}/vector] START: k=${k}, n=${n}`);

  try {
    const { ref, candidates, error, status } =
      await findVectorSimilarCandidates(id, k);

    if (error) {
      return res.status(status).json({ error });
    }

    // Sort by distance and take top n
    const sortedCandidates = candidates
      .sort((a, b) => a.dist - b.dist)
      .slice(0, n);
    const finalIds = sortedCandidates.map((c) => c.id);

    console.log(
      `[similar/${id}/vector] Top ${n} vector IDs: ${JSON.stringify(finalIds)}`
    );

    // Fetch full details for the final IDs, preserving order
    if (finalIds.length === 0) {
      console.log(`[similar/${id}/vector] No similar posts found.`);
      return res.json([]);
    }

    const numericFinalIds = finalIds.map(Number);
    const { rows: finals } = await pool.query(
      "SELECT * FROM content WHERE id = ANY($1::int[])",
      [numericFinalIds]
    );
    console.log(
      `[similar/${id}/vector] Found ${finals.length} posts in DB matching final IDs.`
    );

    const ordered = finalIds
      .map((fid) => finals.find((r) => r.id === Number(fid)))
      .filter(Boolean);
    console.log(
      `[similar/${id}/vector] Returning ${ordered.length} ordered posts.`
    );

    res.json(ordered);
  } catch (err) {
    console.error(`[similar/${id}/vector] Error in route:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Endpoint for AI Re-ranked Similar Posts ---
app.get("/api/similar/:id/ai", async (req, res) => {
  const { id } = req.params;
  const k = 20; // candidates for AI rerank
  const n = 20; // final results
  console.log(`[similar/${id}/ai] START: k=${k}, n=${n}`);

  try {
    // 1. Get reference and candidates using the helper
    const {
      ref,
      candidates: uniqueCands,
      error,
      status,
    } = await findVectorSimilarCandidates(id, k);

    if (error) {
      return res.status(status).json({ error });
    }

    /* ---------- 2. Gemini re-rank ---------- */
    let finalIds = [];
    if (genAI && GEMINI_MODEL && uniqueCands.length > 0) {
      const prompt = buildRerankPrompt(ref, uniqueCands);
      console.log(
        `[similar/${id}/ai] Sending prompt to Gemini for reranking ${uniqueCands.length} candidates down to ${n}...`
      );
      // console.log(`[similar/${id}/ai] Gemini Prompt:\n${prompt}`); // Uncomment for full prompt

      try {
        const resp = await genAI.models.generateContent({
          model: GEMINI_MODEL,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        });

        // console.log("Gemini Response Object:", JSON.stringify(resp, null, 2)); // Log the full response object for debugging
        const geminiResponseText = resp.candidates[0].content.parts[0].text;
        console.log(
          `[similar/${id}/ai] Gemini raw response: ${geminiResponseText}`
        );

        // Extract the JSON array part robustly
        const jsonMatch = geminiResponseText.match(/(\[[\s\S]*?\])/); // More robust regex to find the array
        if (jsonMatch && jsonMatch[1]) {
          finalIds = JSON.parse(jsonMatch[1]);
          // Ensure we only take up to 'n' results from AI
          if (finalIds.length > n) {
            console.warn(
              `[similar/${id}/ai] Gemini returned ${finalIds.length} IDs, truncating to ${n}.`
            );
            finalIds = finalIds.slice(0, n);
          }
          console.log(
            `[similar/${id}/ai] Parsed Gemini IDs (${
              finalIds.length
            }): ${JSON.stringify(finalIds)}`
          );
        } else {
          console.warn(
            `[similar/${id}/ai] No valid JSON array found in Gemini response: "${geminiResponseText}"`
          );
          // Fallback will be triggered below
        }
      } catch (e) {
        console.error(
          `[similar/${id}/ai] Gemini call or JSON parse failed:`,
          e
        );
        // Fallback will be triggered below
      }
    } else if (uniqueCands.length === 0) {
      console.log(`[similar/${id}/ai] No candidates found for AI reranking.`);
    } else {
      console.log(
        `[similar/${id}/ai] Gemini client/model not configured or no candidates, skipping rerank.`
      );
    }

    // 3. Fallback or use vector order if Gemini missing / failed / no candidates initially
    if (!Array.isArray(finalIds) || finalIds.length === 0) {
      if (uniqueCands.length > 0) {
        console.log(
          `[similar/${id}/ai] Using fallback vector similarity order.`
        );
        finalIds = uniqueCands
          .sort((a, b) => a.dist - b.dist) // Sort by distance
          .slice(0, n) // Take top n
          .map((r) => r.id); // Get IDs
        console.log(
          `[similar/${id}/ai] Fallback IDs (${
            finalIds.length
          }): ${JSON.stringify(finalIds)}`
        );
      } else {
        console.log(
          `[similar/${id}/ai] No candidates for fallback, returning empty.`
        );
        finalIds = [];
      }
    }

    // 4. Fetch final rows & preserve order
    if (finalIds.length === 0) {
      console.log(`[similar/${id}/ai] No final IDs to fetch, returning empty.`);
      return res.json([]);
    }

    console.log(
      `[similar/${id}/ai] Fetching final ${finalIds.length} posts...`
    );
    const numericFinalIds = finalIds.map(String).map(Number); // Ensure IDs are numbers for query
    const { rows: finals } = await pool.query(
      "SELECT * FROM content WHERE id = ANY($1::int[])",
      [numericFinalIds] // Use the numeric array
    );
    console.log(
      `[similar/${id}/ai] Found ${finals.length} posts in DB matching final IDs.`
    );

    const ordered = finalIds
      .map((fid) => finals.find((r) => r.id === Number(fid))) // Compare with numeric ID
      .filter(Boolean); // Remove any potential nulls if an ID wasn't found

    if (ordered.length !== finalIds.length) {
      console.warn(
        `[similar/${id}/ai] Mismatch between final IDs (${finalIds.length}) and fetched posts (${ordered.length}). Some IDs might be invalid or missing.`
      );
    }

    console.log(
      `[similar/${id}/ai] Returning ${ordered.length} ordered posts.`
    );
    res.json(ordered);
  } catch (err) {
    console.error(`[similar/${id}/ai] Error in route:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start the server and listen on the defined port
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
