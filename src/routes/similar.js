// /api/similar/:id: posts nearest to a given post by embedding.

const express = require("express");
const { pool } = require("../db");
const {
  V1_POST_COLS,
  PG_INT4_MAX,
  sendError,
} = require("../params");

const router = express.Router();

// Similar posts: nearest neighbours by cosine distance over both embeddings.
// Each embedding gets its own KNN query (so pgvector can use its index), and a
// post found by both keeps its smaller distance.
const SIMILAR_LIMIT = 20;

async function similarHandler(req, res) {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: "id must be a non-negative integer" });
  }
  const id = Number(req.params.id);
  if (id > PG_INT4_MAX) return res.status(404).json({ error: "Post not found" });

  try {
    const {
      rows: [ref],
    } = await pool.query(
      `SELECT embedding_short, embedding_full FROM content
        WHERE id = $1 AND embedding_short IS NOT NULL AND embedding_full IS NOT NULL`,
      [id]
    );
    if (!ref) return res.status(404).json({ error: "Post not found" });

    const { rows } = await pool.query(
      `WITH cands AS (
         (SELECT id, embedding_short <=> $1 AS dist
            FROM content
           WHERE id <> $3 AND embedding_short IS NOT NULL
           ORDER BY embedding_short <=> $1
           LIMIT $2)
         UNION ALL
         (SELECT id, embedding_full <=> $4 AS dist
            FROM content
           WHERE id <> $3 AND embedding_full IS NOT NULL
           ORDER BY embedding_full <=> $4
           LIMIT $2)
       ), best AS (
         SELECT id, MIN(dist) AS dist FROM cands GROUP BY id
       )
       SELECT ${V1_POST_COLS}
         FROM best JOIN content USING (id)
        ORDER BY best.dist, id
        LIMIT $2`,
      [ref.embedding_short, SIMILAR_LIMIT, id, ref.embedding_full]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, "GET /api/similar/:id");
  }
}
router.get("/api/similar/:id", similarHandler);
// Deprecated alias: the AI re-ranking is gone, but the deployed frontend still
// calls /ai until it redeploys. Delete once the new frontend is live.
router.get("/api/similar/:id/ai", similarHandler);

module.exports = router;
