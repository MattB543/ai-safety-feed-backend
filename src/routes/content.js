// The website's endpoints under /api: source/tag counts, the legacy feed,
// bookmarks, the CSV export and the single-post card.

const express = require("express");
const QueryStream = require("pg-query-stream");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { pool } = require("../db");
const {
  V1_POST_FIELDS,
  selectCols,
  V1_POST_COLS,
  PG_INT4_MAX,
  sendError,
  scalarParam,
  listParam,
  boolParam,
  intParam,
  sortParam,
  noveltyBucketMin,
  buildV1Where,
} = require("../params");

const router = express.Router();

// Endpoint to fetch distinct source types
router.get("/api/sources", async (req, res) => {
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

// Post counts per source → [{ source_type: 'EA Forum', count: 52 }, …].
// Takes the same filters as /api/v1/posts, so the website's source counts
// follow its search, tag and novelty filters.
router.get("/api/source-stats", async (req, res) => {
  try {
    const { whereSQL, params } = buildV1Where(req.query);
    const { rows } = await pool.query(
      `SELECT source_type, COUNT(*)::int AS count
         FROM content
         ${whereSQL}
        GROUP BY source_type
        ORDER BY source_type`,
      params
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, "GET /api/source-stats");
  }
});

// Endpoint to fetch distinct tags (cluster_tag + topics[]) with counts
router.get("/api/tags", async (_req, res) => {
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

// DEPRECATED: the feed endpoint of the pre-cleanup website, which now uses
// /api/v1/posts. Delete once the new frontend is live on Netlify.
// Maps the old params (comma-separated sources and tags, novelty_bucket 1-5,
// order_by=random) onto the v1 helpers and returns a bare array.
router.get("/api/content", async (req, res) => {
  try {
    const q = req.query;
    const noveltyMin = noveltyBucketMin(scalarParam(q, "novelty_bucket"));
    const { whereSQL, params } = buildV1Where({
      search: q.search,
      sources: q.sources,
      tags: q.tags,
      novelty_min: noveltyMin === undefined ? undefined : String(noveltyMin),
    });
    const orderSQL = sortParam({
      sort: scalarParam(q, "order_by") === "random" ? "random" : "newest",
    });
    const limit = intParam(q, "limit", 50, 1, 100);
    const offset = intParam(q, "offset", 0, 0, Number.MAX_SAFE_INTEGER);

    const { rows } = await pool.query(
      `SELECT ${V1_POST_COLS} FROM content ${whereSQL}
       ORDER BY ${orderSQL}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, "GET /api/content");
  }
});

// Posts by id, for the website's bookmarks: ?ids=1,2,3 (or repeat the key).
// Returns a bare array in no particular order; unknown ids are left out.
const MAX_BY_IDS = 100;
router.get("/api/content/by-ids", async (req, res) => {
  const raw = listParam(req.query, "ids", { split: true });
  if (!raw.length) {
    return res.status(400).json({ error: "Missing 'ids' query parameter" });
  }
  if (raw.length > MAX_BY_IDS) {
    return res.status(400).json({ error: `At most ${MAX_BY_IDS} ids per request` });
  }
  const idList = [
    ...new Set(
      raw
        .filter((s) => /^\d+$/.test(s))
        .map(Number)
        .filter((id) => id > 0 && id <= PG_INT4_MAX)
    ),
  ];
  if (!idList.length) {
    return res
      .status(400)
      .json({ error: "No valid IDs provided in 'ids' query parameter" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT ${V1_POST_COLS} FROM content WHERE id = ANY($1::int[])`,
      [idList]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, "GET /api/content/by-ids");
  }
});

// Each export holds a pooled DB connection for the whole download, so cap how
// many run at once; otherwise a handful of slow clients could starve the site.
const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;

function csvCell(v) {
  if (v === null || v === undefined) return "";
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  // Spreadsheets run text starting with = + - @ (or tab/CR) as a formula, and
  // titles and summaries are scraped text. A leading ' makes it plain text.
  // Real numbers (e.g. a negative score) can't be formulas and stay numeric.
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @swagger
 * /api/content/export:
 *   get:
 *     summary: Download the dataset as CSV
 *     description: |
 *       Streams every post (or the filtered subset) as a UTF-8 CSV, one row per post, ordered by id. The columns are the fields of the Post schema; arrays such as authors and topics are JSON-encoded in their cell.
 *       The article body is left out by default; pass `include_content=true` to add a `full_content_markdown` column (the download is then roughly ten times larger). At most two exports run at once; a third gets a 429 with a Retry-After header.
 *     tags: [Feeds]
 *     parameters:
 *       - $ref: '#/components/parameters/search'
 *       - $ref: '#/components/parameters/source_type'
 *       - $ref: '#/components/parameters/sources'
 *       - $ref: '#/components/parameters/tags'
 *       - $ref: '#/components/parameters/topics'
 *       - $ref: '#/components/parameters/novelty_min'
 *       - $ref: '#/components/parameters/novelty_max'
 *       - $ref: '#/components/parameters/published_after'
 *       - $ref: '#/components/parameters/published_before'
 *       - in: query
 *         name: include_content
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid parameter value
 *       429:
 *         description: Too many exports in progress; retry after the Retry-After delay
 */
router.get("/api/content/export", async (req, res) => {
  let where;
  let includeContent;
  try {
    where = buildV1Where(req.query);
    includeContent = boolParam(req.query, "include_content");
  } catch (err) {
    return sendError(res, err, "GET /api/content/export");
  }

  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.set("Retry-After", "30");
    return res
      .status(429)
      .json({ error: "Too many exports in progress; try again in about 30 seconds" });
  }
  activeExports++;

  const fields = includeContent ? [...V1_POST_FIELDS, "full_content_markdown"] : V1_POST_FIELDS;
  const sql = `SELECT ${selectCols(fields)} FROM content ${where.whereSQL} ORDER BY id`;

  let client;
  let failure;
  try {
    client = await pool.connect();
    // Cursor-backed stream: rows are fetched in batches as the response
    // drains, so memory stays flat however large the table gets.
    const rows = client.query(
      new QueryStream(sql, where.params, { batchSize: includeContent ? 25 : 200 })
    );
    const toCsv = new Transform({
      objectMode: true,
      transform(row, _enc, cb) {
        cb(null, fields.map((f) => csvCell(row[f])).join(",") + "\n");
      },
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ai-safety-feed-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.write(fields.join(",") + "\n");
    // pipeline() propagates failure in both directions: a DB error cuts the
    // response (the client sees a truncated download, not a "complete" partial
    // file) and a client that disconnects destroys the cursor.
    await pipeline(rows, toCsv, res);
  } catch (err) {
    failure = err;
    if (err.code === "ERR_STREAM_PREMATURE_CLOSE") {
      // Client went away mid-download; nothing to report.
    } else if (!res.headersSent) {
      sendError(res, err, "GET /api/content/export");
    } else {
      console.error("[GET /api/content/export] failed mid-stream:", err);
      res.destroy();
    }
  } finally {
    activeExports--;
    // Passing the error makes the pool discard a client whose cursor may still
    // be mid-flight instead of handing it to the next request.
    if (client) client.release(failure);
  }
});

// Single post by id, without the article body (the old Similar page's
// reference card). The new frontend uses /api/v1/posts/:id instead.
// NOTE: This must come *after* /api/content/by-ids and /export to avoid conflict
router.get("/api/content/:id", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: "id must be a non-negative integer" });
  }
  const id = Number(req.params.id);
  if (id > PG_INT4_MAX) return res.sendStatus(404);
  try {
    const {
      rows: [post],
    } = await pool.query(`SELECT ${V1_POST_COLS} FROM content WHERE id = $1`, [id]);
    if (post) {
      res.json(post);
    } else {
      res.sendStatus(404);
    }
  } catch (err) {
    sendError(res, err, "GET /api/content/:id");
  }
});

module.exports = router;
module.exports.csvCell = csvCell;
