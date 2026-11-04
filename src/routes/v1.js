// Public v1 API: reads public.content, the same table the website uses.
// Documented in Swagger at /api-docs; the components block below defines the
// shared Post schema and filter parameters the other route files refer to.

const express = require("express");
const { pool } = require("../db");
const {
  V1_POST_COLS,
  V1_POST_COLS_WITH_CONTENT,
  PG_INT4_MAX,
  UUID_RE,
  sendError,
  boolParam,
  intParam,
  sortParam,
  buildV1Where,
} = require("../params");

const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     Post:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Stable numeric identifier
 *         uuid:
 *           type: string
 *           format: uuid
 *         title:
 *           type: string
 *           description: Title as published at the source
 *         cleaned_title:
 *           type: string
 *           nullable: true
 *           description: Tidied title, when one was generated. The website shows this when present and title otherwise.
 *         source_url:
 *           type: string
 *           format: uri
 *         source_type:
 *           type: string
 *           example: "Less Wrong"
 *         authors:
 *           type: array
 *           nullable: true
 *           items:
 *             type: string
 *         published_date:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         sentence_summary:
 *           type: string
 *           nullable: true
 *           description: One-sentence AI-generated summary
 *         paragraph_summary:
 *           type: string
 *           nullable: true
 *           description: Paragraph-length AI-generated summary (light markdown)
 *         key_implication:
 *           type: string
 *           nullable: true
 *         why_valuable:
 *           type: string
 *           nullable: true
 *         unique_aspects:
 *           type: string
 *           nullable: true
 *         author_credentials:
 *           type: string
 *           nullable: true
 *         novelty_score:
 *           type: number
 *           nullable: true
 *           minimum: 0
 *           maximum: 100
 *         novelty_note:
 *           type: string
 *           nullable: true
 *         cluster_tag:
 *           type: string
 *           nullable: true
 *           description: Single high-level category (see /api/v1/posts/tags)
 *           example: "AI Governance & Policy"
 *         topics:
 *           type: array
 *           nullable: true
 *           items:
 *             type: string
 *           description: Finer-grained topics (see /api/v1/posts/topics)
 *         image_url:
 *           type: string
 *           format: uri
 *           nullable: true
 *         cleaned_image:
 *           type: string
 *           format: uri
 *           nullable: true
 *         image_prompt:
 *           type: string
 *           nullable: true
 *           description: Text prompt the post's generated image was made from; the website uses it as the image's alt text and tooltip
 *         audio_url:
 *           type: string
 *           format: uri
 *           nullable: true
 *           description: Episode audio for podcast sources
 *         score:
 *           type: integer
 *           nullable: true
 *           description: Source-site score (e.g. forum karma), where available
 *         comment_count:
 *           type: integer
 *           nullable: true
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: When the post was added to the feed
 *         updated_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         full_content_markdown:
 *           type: string
 *           nullable: true
 *           description: Article body as markdown. Only present on single-post endpoints or when include_content=true.
 *     Pagination:
 *       type: object
 *       properties:
 *         total:
 *           type: integer
 *         limit:
 *           type: integer
 *         offset:
 *           type: integer
 *         hasMore:
 *           type: boolean
 *   parameters:
 *     search:
 *       in: query
 *       name: search
 *       schema:
 *         type: string
 *       description: Case-insensitive substring match on title, summaries, key implication, authors, topics and tag. Truncated to 200 characters.
 *     source_type:
 *       in: query
 *       name: source_type
 *       schema:
 *         type: array
 *         items:
 *           type: string
 *       style: form
 *       explode: true
 *       description: Exact source name (see /api/v1/posts/sources). Repeat the parameter for several sources, e.g. `?source_type=EA Forum&source_type=Less Wrong`.
 *     sources:
 *       in: query
 *       name: sources
 *       schema:
 *         type: string
 *       description: Comma-separated alias for source_type. Cannot express names that contain a comma, such as "80,000 Hours Podcast"; use source_type for those.
 *     tags:
 *       in: query
 *       name: tags
 *       schema:
 *         type: string
 *       description: Cluster tags, case-insensitive; comma-separated or repeat the parameter (see /api/v1/posts/tags)
 *       example: "ai governance & policy"
 *     topics:
 *       in: query
 *       name: topics
 *       schema:
 *         type: string
 *       description: Topics, case-insensitive; comma-separated or repeat the parameter. Matches posts with any of them (see /api/v1/posts/topics)
 *     novelty_min:
 *       in: query
 *       name: novelty_min
 *       schema:
 *         type: number
 *         minimum: 0
 *         maximum: 100
 *       description: Minimum novelty score
 *     novelty_max:
 *       in: query
 *       name: novelty_max
 *       schema:
 *         type: number
 *         minimum: 0
 *         maximum: 100
 *       description: Maximum novelty score
 *     published_after:
 *       in: query
 *       name: published_after
 *       schema:
 *         type: string
 *         format: date
 *       description: Only posts published on or after this date or ISO timestamp
 *     published_before:
 *       in: query
 *       name: published_before
 *       schema:
 *         type: string
 *         format: date
 *       description: Only posts published before this date or ISO timestamp
 */

/**
 * @swagger
 * /api/v1/posts/sources:
 *   get:
 *     summary: List sources with post counts
 *     tags: [Metadata]
 *     responses:
 *       200:
 *         description: One entry per source
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   source_type:
 *                     type: string
 *                   count:
 *                     type: integer
 *                   latest_published:
 *                     type: string
 *                     format: date-time
 */
router.get("/api/v1/posts/sources", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT source_type, COUNT(*)::int AS count, MAX(published_date) AS latest_published
      FROM   content
      WHERE  source_type IS NOT NULL
      GROUP  BY source_type
      ORDER  BY source_type
    `);
    res.json(rows);
  } catch (err) {
    sendError(res, err, "GET /api/v1/posts/sources");
  }
});

/**
 * @swagger
 * /api/v1/posts/tags:
 *   get:
 *     summary: List cluster tags with post counts
 *     description: Every post has one cluster tag, a high-level category. Use the `tags` filter on /api/v1/posts to select by it.
 *     tags: [Metadata]
 *     responses:
 *       200:
 *         description: Tags ordered by post count
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   tag:
 *                     type: string
 *                   count:
 *                     type: integer
 */
router.get("/api/v1/posts/tags", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT MIN(cluster_tag) AS tag, COUNT(*)::int AS count
      FROM   content
      WHERE  cluster_tag IS NOT NULL
      GROUP  BY LOWER(cluster_tag)
      ORDER  BY count DESC, tag ASC
    `);
    res.json(rows);
  } catch (err) {
    sendError(res, err, "GET /api/v1/posts/tags");
  }
});

/**
 * @swagger
 * /api/v1/posts/topics:
 *   get:
 *     summary: List topics with post counts
 *     description: Posts carry several finer-grained topics. Use the `topics` filter on /api/v1/posts to select by them.
 *     tags: [Metadata]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 100
 *         description: Number of topics to return, most common first
 *     responses:
 *       200:
 *         description: Topics ordered by post count
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   topic:
 *                     type: string
 *                   count:
 *                     type: integer
 *       400:
 *         description: Invalid limit
 */
router.get("/api/v1/posts/topics", async (req, res) => {
  try {
    const limit = intParam(req.query, "limit", 100, 1, 1000);
    const { rows } = await pool.query(
      `
      SELECT MIN(t) AS topic, COUNT(DISTINCT content.id)::int AS count
      FROM   content, unnest(topics) AS t
      WHERE  t IS NOT NULL AND t <> ''
      GROUP  BY LOWER(t)
      ORDER  BY count DESC, topic ASC
      LIMIT  $1
    `,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err, "GET /api/v1/posts/topics");
  }
});

/**
 * @swagger
 * /api/v1/posts/stats:
 *   get:
 *     summary: Dataset statistics
 *     tags: [Metadata]
 *     responses:
 *       200:
 *         description: Totals and date range
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total_posts:
 *                   type: integer
 *                 sources:
 *                   type: integer
 *                 tags:
 *                   type: integer
 *                 date_range:
 *                   type: object
 *                   properties:
 *                     earliest:
 *                       type: string
 *                       format: date-time
 *                     latest:
 *                       type: string
 *                       format: date-time
 *                 last_ingested:
 *                   type: string
 *                   format: date-time
 *                   description: When the most recent post was added to the feed
 */
router.get("/api/v1/posts/stats", async (_req, res) => {
  try {
    const {
      rows: [s],
    } = await pool.query(`
      SELECT COUNT(*)::int                           AS total_posts,
             COUNT(DISTINCT source_type)::int        AS sources,
             COUNT(DISTINCT LOWER(cluster_tag))::int AS tags,
             MIN(published_date)                     AS earliest,
             MAX(published_date)                     AS latest,
             MAX(created_at)                         AS last_ingested
      FROM   content
    `);
    res.json({
      total_posts: s.total_posts,
      sources: s.sources,
      tags: s.tags,
      date_range: { earliest: s.earliest, latest: s.latest },
      last_ingested: s.last_ingested,
    });
  } catch (err) {
    sendError(res, err, "GET /api/v1/posts/stats");
  }
});

/**
 * @swagger
 * /api/v1/posts:
 *   get:
 *     summary: List posts with filtering and pagination
 *     description: |
 *       Returns curated AI safety posts (forum posts, blog posts, newsletters, podcast episodes) with AI-generated summaries, tags and novelty scores.
 *       Results are newest-first by default. The article body is omitted unless `include_content=true`. The CSV export at `/api/content/export` and the RSS feed at `/rss.xml` accept the same filters.
 *     tags: [Posts]
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
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [newest, oldest, novelty, random]
 *           default: newest
 *       - in: query
 *         name: include_content
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include full_content_markdown in each post
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Page size; values above 100 are clamped
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Post'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         description: Invalid parameter value
 */
router.get("/api/v1/posts", async (req, res) => {
  try {
    const { whereSQL, params } = buildV1Where(req.query);
    const orderSQL = sortParam(req.query);
    const limit = intParam(req.query, "limit", 20, 1, 100);
    const offset = intParam(req.query, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const cols = boolParam(req.query, "include_content")
      ? V1_POST_COLS_WITH_CONTENT
      : V1_POST_COLS;

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT ${cols} FROM content ${whereSQL}
         ORDER BY ${orderSQL}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM content ${whereSQL}`, params),
    ]);
    const total = countResult.rows[0].total;
    res.json({
      data: dataResult.rows,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + dataResult.rows.length < total,
      },
    });
  } catch (err) {
    sendError(res, err, "GET /api/v1/posts");
  }
});

async function sendSinglePost(res, whereSQL, param, label) {
  try {
    const { rows } = await pool.query(
      `SELECT ${V1_POST_COLS_WITH_CONTENT} FROM content WHERE ${whereSQL}`,
      [param]
    );
    if (!rows.length) return res.status(404).json({ error: "Post not found" });
    res.json(rows[0]);
  } catch (err) {
    sendError(res, err, label);
  }
}

/**
 * @swagger
 * /api/v1/posts/by-uuid/{uuid}:
 *   get:
 *     summary: Get a single post by UUID
 *     description: Includes the article body (full_content_markdown).
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       400:
 *         description: Malformed UUID
 *       404:
 *         description: Post not found
 */
router.get("/api/v1/posts/by-uuid/:uuid", (req, res) => {
  if (!UUID_RE.test(req.params.uuid)) {
    return res.status(400).json({ error: "uuid must be a valid UUID" });
  }
  return sendSinglePost(res, "uuid = $1", req.params.uuid, "GET /api/v1/posts/by-uuid");
});

/**
 * @swagger
 * /api/v1/posts/{id}:
 *   get:
 *     summary: Get a single post by ID
 *     description: Includes the article body (full_content_markdown).
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       400:
 *         description: Non-integer id
 *       404:
 *         description: Post not found
 */
router.get("/api/v1/posts/:id", (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: "id must be a non-negative integer" });
  }
  const id = Number(req.params.id);
  if (id > PG_INT4_MAX) return res.status(404).json({ error: "Post not found" });
  return sendSinglePost(res, "id = $1", id, "GET /api/v1/posts/:id");
});

module.exports = router;
