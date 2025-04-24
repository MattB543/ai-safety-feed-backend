const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Parser } = require("json2csv");

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
      `CANDIDATE ${i + 1}
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
Based on semantic similarity (considering topics, summaries, implications, etc.), return a JSON array only with 5 to 10 candidate IDs, ordered most similar to least similar when compared to the REFERENCE ARTICLE.
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

app.get("/api/similar/:id", async (req, res) => {
  const { id } = req.params;
  const k = 15; // candidates
  const n = 10; // final results
  console.log(`[similar/${id}] START: k=${k}, n=${n}`);

  try {
    // 1. reference row + embeddings
    console.log(`[similar/${id}] Fetching reference post...`);
    const {
      rows: [ref],
    } = await pool.query(
      "SELECT * FROM content WHERE id=$1 AND embedding_short IS NOT NULL AND embedding_full IS NOT NULL",
      [id]
    );
    if (!ref) {
      console.log(`[similar/${id}] Reference post not found.`);
      return res.status(404).json({ error: "Post not found" });
    }
    console.log(`[similar/${id}] Found reference post: ${ref.title}`);

    // 2. pgvector nearest-neighbour union
    console.log(
      `[similar/${id}] Fetching ${k} candidates via vector search...`
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
    console.log(`[similar/${id}] Found ${cands.length} candidates.`);

    // Deduplicate candidates based on ID, keeping the first occurrence
    const uniqueCandsMap = new Map();
    cands.forEach((cand) => {
      if (!uniqueCandsMap.has(cand.id)) {
        uniqueCandsMap.set(cand.id, cand);
      }
    });
    const uniqueCands = Array.from(uniqueCandsMap.values());
    console.log(
      `[similar/${id}] Deduplicated to ${uniqueCands.length} unique candidates.`
    );

    /* ---------- 3. Gemini re-rank (optional) ---------- */
    let finalIds;
    if (genAI && GEMINI_MODEL) {
      const prompt = buildRerankPrompt(ref, uniqueCands);
      console.log(
        `[similar/${id}] Sending prompt to Gemini for reranking ${uniqueCands.length} candidates down to ${n}...`
      );
      console.log(`[similar/${id}] Gemini Prompt:\n${prompt}`); // Uncomment for full prompt
      const resp = await genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      });

      try {
        console.log("Response:", resp);
        const geminiResponseText = resp.candidates[0].content.parts[0].text;
        console.log(
          `[similar/${id}] Gemini raw response: ${geminiResponseText}`
        );
        // Extract the JSON array part
        const jsonMatch = geminiResponseText.match(/\[.*\]/s);
        if (jsonMatch && jsonMatch[0]) {
          finalIds = JSON.parse(jsonMatch[0]);
          console.log(
            `[similar/${id}] Parsed Gemini IDs: ${JSON.stringify(finalIds)}`
          );
        } else {
          throw new Error("No valid JSON array found in Gemini response");
        }
      } catch (e) {
        console.warn(
          `[similar/${id}] Gemini JSON parse failed, falling back to vector order:`,
          e
        );
      }
    } else {
      console.log(
        `[similar/${id}] Gemini client or model not configured, skipping rerank.`
      );
    }

    // 4. fallback or use vector order if Gemini missing / failed
    if (!Array.isArray(finalIds) || finalIds.length === 0) {
      console.log(`[similar/${id}] Using fallback vector similarity order.`);
      // Use uniqueCands for fallback as well
      finalIds = uniqueCands
        .sort((a, b) => a.dist - b.dist)
        .slice(0, n)
        .map((r) => r.id);
      console.log(`[similar/${id}] Fallback IDs: ${JSON.stringify(finalIds)}`);
    }

    // 5. fetch rows & preserve order
    console.log(`[similar/${id}] Fetching final ${finalIds.length} posts...`);
    const numericFinalIds = finalIds.map(Number); // Convert string IDs to numbers
    const { rows: finals } = await pool.query(
      "SELECT * FROM content WHERE id = ANY($1::int[])",
      [numericFinalIds] // Use the numeric array
    );
    console.log(
      `[similar/${id}] Found ${finals.length} posts in DB matching final IDs.`
    );
    const ordered = finalIds
      .map((fid) => finals.find((r) => r.id === Number(fid))) // Compare with numeric ID
      .filter(Boolean);
    console.log(`[similar/${id}] Returning ${ordered.length} ordered posts.`);

    res.json(ordered);
  } catch (err) {
    console.error(`[similar/${id}] Error in route:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start the server and listen on the defined port
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
