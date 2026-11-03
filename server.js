const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const QueryStream = require("pg-query-stream");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const postmark = require("postmark");
const { v4: uuidv4 } = require("uuid");
const cron = require("node-cron"); // Import node-cron

const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

// Initialize Postmark Client
let postmarkClient;
if (process.env.POSTMARK_API_KEY) {
  postmarkClient = new postmark.ServerClient(process.env.POSTMARK_API_KEY);
  console.log("Postmark client initialized successfully.");
} else {
  console.warn(
    "WARN: POSTMARK_API_KEY not found in .env. Email functionality will be disabled."
  );
}

// Helper function to escape HTML characters
function escapeHtml(unsafe) {
  if (typeof unsafe !== "string") {
    return unsafe; // Return as is if not a string
  }
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Helper function to get display title (matching frontend logic)
function getDisplayTitle(article) {
  if (article.cleaned_title && article.cleaned_title !== article.title) {
    return article.cleaned_title;
  }
  return article.title || "";
}

// Helper function to slugify text (matching frontend logic)
function slugify(text) {
  if (!text) {
    return "no-title";
  }

  // Convert to string, lowercase, and trim
  let slug = String(text).toLowerCase().trim();

  // Replace spaces with hyphens
  slug = slug.replace(/\s+/g, "-");

  // Remove all non-word characters except hyphens
  slug = slug.replace(/[^\w\-]+/g, "");

  // Replace multiple hyphens with single hyphen
  slug = slug.replace(/\-\-+/g, "-");

  // Trim hyphens from start and end
  slug = slug.replace(/^-+|-+$/g, "");

  return slug;
}

// Helper function to calculate read time from markdown content
function calculateReadTime(markdownContent) {
  if (!markdownContent) return null;

  // Remove markdown syntax for more accurate word count
  const plainText = markdownContent
    .replace(/```[\s\S]*?```/g, "") // Remove code blocks
    .replace(/`.*?`/g, "") // Remove inline code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // Replace links with text
    .replace(/[#*_~>\-]/g, "") // Remove markdown symbols
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();

  const wordCount = plainText.split(/\s+/).length;
  const wordsPerMinute = 200; // Average reading speed
  const minutes = Math.ceil(wordCount / wordsPerMinute);

  return minutes;
}

// Helper function to get source type text label
function getSourceTypeText(sourceType) {
  if (!sourceType) return "Blog Post";

  const type = sourceType.toLowerCase();

  // Explicit mappings for all your source types
  const sourceTypeMap = {
    // Forum Posts
    "ea forum": "Forum Post",
    "less wrong": "Forum Post",
    "alignment forum": "Forum Post",

    // Podcasts
    "techtank podcast": "Podcast",
    "ai governance podcast": "Podcast",
    "80,000 hours podcast": "Podcast",
    axrp: "Podcast",
    "machine ethics podcast": "Podcast",
    "dwarkesh podcast": "Podcast",
    "for humanity: an ai safety podcast": "Podcast",
    "machine learning street talk": "Podcast",
    "clearer thinking": "Podcast",
    "into ai safety": "Podcast",
    "ai, government, and the future": "Podcast",

    // Blog Posts
    "don't worry about the vase": "Blog Post",
    "musings on the alignment problem": "Blog Post",
    "miles's substack": "Blog Post",
    "joe carlsmith's substack": "Blog Post",
    "rising tide": "Blog Post",
    "epoch ai": "Blog Post",
    "enterprise ai governance": "Blog Post",
    "agi friday": "Blog Post",
    "ai frontiers": "Blog Post",
    hyperdimensional: "Blog Post",
    "ml safety newsletter": "Blog Post",
    "ai safety newsletter": "Blog Post",
    "the eu ai act newsletter": "Blog Post",
  };

  // Check exact match first
  if (sourceTypeMap[type]) {
    return sourceTypeMap[type];
  }

  // Fallback to keyword matching for any new sources
  if (type.includes("podcast")) return "Podcast";
  if (type.includes("forum")) return "Forum Post";
  if (type.includes("substack")) return "Blog Post";
  if (type.includes("newsletter")) return "Blog Post";

  // Default to Blog Post
  return "Blog Post";
}

// Helper function to generate similar page URL
function generateSimilarUrl(article, baseUrl) {
  const displayTitle = getDisplayTitle(article);
  const slug = slugify(displayTitle);
  return `${baseUrl}/similar/${slug}-${article.id}`;
}

const app = express();

// Render terminates TLS and proxies to us. Trust that one hop so req.ip, and
// therefore the per-IP rate limit, refers to the client rather than the proxy.
app.set("trust proxy", 1);

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

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "AI Safety Feed Public API",
      version: "1.0.0",
      description: "Public API for accessing AI safety posts and research",
      contact: {
        name: "AI Safety Feed",
        url: "https://aisafetyfeed.com",
      },
    },
    servers: [
      {
        url:
          process.env.API_BASE_URL ||
          process.env.BACKEND_URL ||
          `http://localhost:${PORT}`,
        description: "API Server",
      },
    ],
  },
  apis: ["./server.js"], // Path to file containing JSDoc comments
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Define the /health endpoint
app.get("/health", (req, res) => {
  res.sendStatus(200);
});

app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "AI Safety Feed API Docs",
  })
);

// Helper to generate HTML (extracted from sendDigestEmail)
function generateDigestHtml(subscription, newContent) {
  // Determine the base URL for links
  const port = process.env.PORT || "8000"; // Default port if not specified
  const localBaseUrl = `http://localhost:${port}`;
  const appBaseUrl = process.env.BASE_URL || localBaseUrl;

  const unsubscribeUrl = `${appBaseUrl}/api/unsubscribe/${subscription.unsubscribe_token}`;

  // Calculate summary stats
  const stats = newContent.reduce((acc, item) => {
    const sourceTypeText = getSourceTypeText(item.source_type);

    if (sourceTypeText === "Podcast") {
      acc.podcasts = (acc.podcasts || 0) + 1;
    } else if (sourceTypeText === "Forum Post") {
      acc.forumPosts = (acc.forumPosts || 0) + 1;
    } else if (sourceTypeText === "Blog Post") {
      acc.blogPosts = (acc.blogPosts || 0) + 1;
    }
    return acc;
  }, {});

  const statsParts = [];
  if (stats.forumPosts > 0)
    statsParts.push(
      `${stats.forumPosts} forum post${stats.forumPosts > 1 ? "s" : ""}`
    );
  if (stats.blogPosts > 0)
    statsParts.push(
      `${stats.blogPosts} blog post${stats.blogPosts > 1 ? "s" : ""}`
    );
  if (stats.podcasts > 0)
    statsParts.push(
      `${stats.podcasts} podcast${stats.podcasts > 1 ? "s" : ""}`
    );

  const statsHtml =
    statsParts.length > 0
      ? `<p style="font-size: 1em; color: #666; margin: 10px 0 20px 0; padding: 10px; background-color: #f8f9fa; border-radius: 5px;">
      ${
        subscription.frequency === "weekly" ? "This week's" : "Today's"
      } digest includes: ${statsParts.join(", ")}
    </p>`
      : "";

  // Helper function to render individual item
  function renderItem(item, index, isLastInGroup = false) {
    const itemContainerStyle = `margin-bottom: 15px; padding-bottom: 20px; ${
      !isLastInGroup ? "border-bottom: 1px solid #eee;" : ""
    }`;

    // Use cleaned_title if available
    const displayTitle = getDisplayTitle(item);

    // Calculate read time
    const readTime = calculateReadTime(item.full_content_markdown);
    const readTimeText = readTime ? `${readTime} min read` : "";

    // Add image if available (with safety checks)
    // For weekly digests, only show images for high novelty posts to manage email size
    const imageUrl = item.cleaned_image || item.image_url;
    const shouldShowImage =
      imageUrl &&
      (subscription.frequency === "daily" ||
        (item.novelty_score && item.novelty_score >= 71)); // Only show images for novelty 4-5 in weekly
    const imageHtml = shouldShowImage
      ? `<img src="${escapeHtml(imageUrl)}" 
            alt="${escapeHtml(item.image_prompt || displayTitle)}" 
            style="width: 100%; max-width: 150px; height: auto; margin: 10px 0; border-radius: 8px;"
            width="150">`
      : "";

    // Create metadata line (source category | source_type | published date | read time) - goes below title
    const publishedDateFormatted = new Date(
      item.published_date
    ).toLocaleDateString();
    const metadataParts = [];

    if (item.source_type) {
      const sourceTypeText = getSourceTypeText(item.source_type);
      metadataParts.push(
        `${sourceTypeText}&nbsp;&nbsp;|&nbsp;&nbsp;${item.source_type}`
      );
    }
    metadataParts.push(`${publishedDateFormatted}`);
    if (readTimeText) {
      metadataParts.push(readTimeText);
    }

    const metadataHtml =
      metadataParts.length > 0
        ? `<p style="font-size: 0.9em; color: #888; margin: 5px 0 10px 0;">${metadataParts.join(
            "&nbsp;&nbsp;|&nbsp;&nbsp;"
          )}</p>`
        : "";

    // 1. Combine Cluster and Topic Tags - now using metadata styling
    let tagsHtml = "";
    const tagParts = [];
    if (item.cluster_tag) {
      tagParts.push(`${escapeHtml(item.cluster_tag)}`);
    }
    if (item.topics && Array.isArray(item.topics) && item.topics.length > 0) {
      const topicsToShow = item.topics
        .slice(0, 3)
        .map((topic) => escapeHtml(topic))
        .join(", ");
      tagParts.push(`${topicsToShow}`);
    }
    if (tagParts.length > 0) {
      tagsHtml = `<p style="font-size: 0.9em; color: #888; margin: 0 0 5px 0;">${tagParts.join(
        "&nbsp;&nbsp;|&nbsp;&nbsp;"
      )}</p>`;
    }

    // 2. Create novelty score and similar post link - using metadata styling
    let noveltyAndLinkHtml = "";
    const noveltyAndLinkParts = [];

    // Add novelty score
    if (item.novelty_score !== null && item.novelty_score !== undefined) {
      let noveltyBucket = 1; // Default to 1 (0-20)
      const score = item.novelty_score;
      if (score >= 91) {
        noveltyBucket = 5;
      } else if (score >= 71) {
        noveltyBucket = 4;
      } else if (score >= 41) {
        noveltyBucket = 3;
      } else if (score >= 21) {
        noveltyBucket = 2;
      }
      noveltyAndLinkParts.push(`Novelty Score: ${noveltyBucket}/5`);
    }

    // Add similar post link
    const viewSimilarPostsUrl = generateSimilarUrl(item, appBaseUrl);
    noveltyAndLinkParts.push(
      `<a href="${viewSimilarPostsUrl}" style="color: #007bff; text-decoration: none;">View details & similar posts</a>`
    );

    if (noveltyAndLinkParts.length > 0) {
      noveltyAndLinkHtml = `<p style="font-size: 0.9em; color: #888; margin: 5px 0 0 0;">${noveltyAndLinkParts.join(
        "&nbsp;&nbsp;|&nbsp;&nbsp;"
      )}</p>`;
    }

    return `
      <div style="${itemContainerStyle}">
        <h3 style="margin-bottom: 5px; font-size: 1.3em;"><a href="${
          item.source_url
        }" style="color: #007bff; text-decoration: none;">${escapeHtml(
      displayTitle
    )}</a></h3>
        ${metadataHtml}
        ${tagsHtml}
        ${imageHtml}
        <p style="font-size: 1.1em; color: #333; margin: 0 0 5px 0; line-height: 1.5;">${
          escapeHtml(item.sentence_summary) || "No summary available."
        }</p>
        ${noveltyAndLinkHtml}
      </div>
    `;
  }

  // Group content by source for weekly digests
  let itemsHtml = "";

  if (subscription.frequency === "weekly") {
    // Group by source_type
    const grouped = newContent.reduce((acc, item) => {
      const source = item.source_type || "Other";
      if (!acc[source]) acc[source] = [];
      acc[source].push(item);
      return acc;
    }, {});

    // Process each group
    const sortedSources = Object.keys(grouped).sort();

    itemsHtml = sortedSources
      .map((source) => {
        const items = grouped[source];
        const needsHeader =
          (source === "LessWrong" || source === "EA Forum") && items.length > 3;

        const headerHtml = needsHeader
          ? `<h4 style="margin: 20px 0 10px 0; font-size: 1.1em; color: #555; border-bottom: 1px solid #eee; padding-bottom: 5px;">
          ${escapeHtml(source)} (${items.length} posts)
        </h4>`
          : "";

        const itemsForSource = items
          .map((item, index) => {
            const isLastInGroup = index === items.length - 1;
            return renderItem(item, index, isLastInGroup);
          })
          .join("");

        return headerHtml + itemsForSource;
      })
      .join("");
  } else {
    // For daily digest, keep original approach
    itemsHtml = newContent
      .map((item, index) => {
        const isLastItem = index === newContent.length - 1;
        return renderItem(item, index, isLastItem);
      })
      .join("");
  }

  return `
    <html>
      <body style="font-family: sans-serif; color: #333;">
        <div style="max-width: 650px; margin-left: 0; margin-right: auto;">
          <h2 style="font-size: 1.6em;">Your ${subscription.frequency} <a href="https://aisafetyfeed.com/" style="text-decoration: underline;">AI Safety Feed</a> Digest</h2>
          ${statsHtml}
          ${itemsHtml}
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 0.9em; color: #888;">
            To unsubscribe from these updates, <a href="${unsubscribeUrl}" style="color: #007bff; text-decoration: none;">click here</a>.
          </p>
        </div>
      </body>
    </html>
  `;
}

// Helper to fetch content for a subscription (extracted and adapted from sendDigestEmail)
async function fetchContentForSubscription(subscription) {
  let fetchSinceDate = new Date();
  if (subscription.last_sent_at) {
    fetchSinceDate = new Date(subscription.last_sent_at);
  } else {
    if (subscription.frequency === "daily") {
      fetchSinceDate.setDate(fetchSinceDate.getDate() - 1);
    } else {
      fetchSinceDate.setDate(fetchSinceDate.getDate() - 7);
    }
  }
  fetchSinceDate.setMinutes(fetchSinceDate.getMinutes() - 5); // Add buffer

  const { searchTerm, sources, tags, novelty } = subscription.filters || {};
  const queryParams = [];
  const queryConditions = ["created_at > $1"];
  queryParams.push(fetchSinceDate);
  let paramIndex = 2;

  // --- Build dynamic query conditions (same logic as before) ---
  if (searchTerm) {
    queryConditions.push(`(
        title ILIKE $${paramIndex} OR
        sentence_summary ILIKE $${paramIndex} OR
        paragraph_summary ILIKE $${paramIndex} OR
        array_to_string(topics,' ') ILIKE $${paramIndex} OR
        cluster_tag ILIKE $${paramIndex}
      )`);
    queryParams.push(`%${searchTerm}%`);
    paramIndex++;
  }
  if (sources && Array.isArray(sources) && sources.length > 0) {
    queryConditions.push(`source_type = ANY($${paramIndex}::text[])`);
    queryParams.push(sources);
    paramIndex++;
  }
  if (tags && Array.isArray(tags) && tags.length > 0) {
    queryConditions.push(`LOWER(cluster_tag) = ANY($${paramIndex}::text[])`);
    queryParams.push(tags);
    paramIndex++;
  }
  if (novelty && typeof novelty === "number" && novelty >= 1 && novelty <= 5) {
    let minScore = 0;
    switch (novelty) {
      case 5:
        minScore = 91;
        break;
      case 4:
        minScore = 71;
        break;
      case 3:
        minScore = 41;
        break;
      case 2:
        minScore = 21;
        break;
    }
    if (minScore > 0) {
      queryConditions.push(`novelty_score >= $${paramIndex}`);
      queryParams.push(minScore);
      paramIndex++;
    }
  }
  // --- End query condition building ---

  const contentQuery = `
    SELECT id, title, source_url, sentence_summary, published_date, cluster_tag, topics, novelty_score, cleaned_title, cleaned_image, image_prompt, source_type, full_content_markdown
    FROM content
    WHERE ${queryConditions.join(" AND ")}
    ORDER BY published_date DESC
    LIMIT 20;
  `;

  try {
    const { rows } = await pool.query(contentQuery, queryParams);
    return rows;
  } catch (err) {
    console.error(
      `[fetchContentForSubscription/${subscription.email}] Error querying content:`,
      err
    );
    return null; // Return null on error
  }
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

// Post counts per source → [{ source_type: 'EA Forum', count: 52 }, …].
// Takes the same filters as /api/v1/posts, so the website's source counts
// follow its search, tag and novelty filters.
app.get("/api/source-stats", async (req, res) => {
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

// DEPRECATED: the feed endpoint of the pre-cleanup website, which now uses
// /api/v1/posts. Delete once the new frontend is live on Netlify.
// Maps the old params (comma-separated sources and tags, novelty_bucket 1-5,
// order_by=random) onto the v1 helpers and returns a bare array.
app.get("/api/content", async (req, res) => {
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
app.get("/api/content/by-ids", async (req, res) => {
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
app.get("/api/content/export", async (req, res) => {
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
app.get("/api/similar/:id", similarHandler);
// Deprecated alias: the AI re-ranking is gone, but the deployed frontend still
// calls /ai until it redeploys. Delete once the new frontend is live.
app.get("/api/similar/:id/ai", similarHandler);

// ---------------------------------------------------------------------------
// Public v1 API — reads public.content, the same table the website uses.
// Documented in Swagger at /api-docs. The helpers here are shared with the CSV
// export and the RSS feed so all three accept the same filters.
// ---------------------------------------------------------------------------

// Fields exposed by the public API and the CSV export, in output order. The
// article body (full_content_markdown) is added only where documented. The
// embedding vectors and internal columns (title_norm, full_content,
// content_snippet) are never exposed. image_prompt is included because the
// website shows it as the card image's tooltip.
const V1_POST_FIELDS = [
  "id",
  "uuid",
  "title",
  "cleaned_title",
  "source_url",
  "source_type",
  "authors",
  "published_date",
  "sentence_summary",
  "paragraph_summary",
  "key_implication",
  "why_valuable",
  "unique_aspects",
  "author_credentials",
  "novelty_score",
  "novelty_note",
  "cluster_tag",
  "topics",
  "image_url",
  "cleaned_image",
  "image_prompt",
  "audio_url",
  "score",
  "comment_count",
  "created_at",
  "updated_at",
];
// novelty_score is NUMERIC in Postgres, which node-pg returns as a string.
const selectCols = (fields) =>
  fields
    .map((f) => (f === "novelty_score" ? "novelty_score::float AS novelty_score" : `"${f}"`))
    .join(", ");
const V1_POST_COLS = selectCols(V1_POST_FIELDS);
const V1_POST_COLS_WITH_CONTENT = selectCols([...V1_POST_FIELDS, "full_content_markdown"]);

const V1_SORTS = {
  newest: "published_date DESC NULLS LAST, id DESC",
  oldest: "published_date ASC NULLS LAST, id ASC",
  novelty: "novelty_score DESC NULLS LAST, published_date DESC, id DESC",
  random: "RANDOM()",
};

const PG_INT4_MAX = 2147483647;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Thrown by the query-parsing helpers below; handlers turn it into a 400.
class ValidationError extends Error {}

function sendError(res, err, label) {
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(`[${label}]`, err);
  return res.status(500).json({ error: "Internal server error" });
}

// Express gives a string for a query key, or an array when the key repeats.
function scalarParam(q, key) {
  const v = q[key];
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string") throw new ValidationError(`${key} must be given once`);
  return v;
}

// Multi-valued param. Repeating the key always works (?a=x&a=y). Splitting on
// commas is opt-in because some values contain commas, e.g. the source
// "80,000 Hours Podcast".
function listParam(q, key, { split }) {
  const raw = q[key];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => (split ? String(v).split(",") : [String(v)]))
    .map((s) => s.trim())
    .filter(Boolean);
}

function boolParam(q, key) {
  const v = scalarParam(q, key);
  return v !== undefined && ["1", "true", "yes"].includes(v.toLowerCase());
}

function intParam(q, key, def, min, max) {
  const v = scalarParam(q, key);
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) throw new ValidationError(`${key} must be a non-negative integer`);
  return Math.min(max, Math.max(min, Number(v)));
}

function numberParam(q, key) {
  const v = scalarParam(q, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`${key} must be a number`);
  return n;
}

function dateParam(q, key) {
  const v = scalarParam(q, key);
  if (v === undefined) return undefined;
  const d = new Date(v);
  // new Date("2026-02-30") silently rolls over to March 2; reject that.
  const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (Number.isNaN(d.getTime()) || (plainDate && d.toISOString().slice(0, 10) !== v)) {
    throw new ValidationError(`${key} must be a valid date (e.g. 2026-01-31 or an ISO timestamp)`);
  }
  return d.toISOString();
}

function sortParam(q) {
  const v = scalarParam(q, "sort") ?? "newest";
  if (!Object.hasOwn(V1_SORTS, v)) {
    throw new ValidationError(`Invalid sort '${v}'. Use one of: ${Object.keys(V1_SORTS).join(", ")}`);
  }
  return V1_SORTS[v];
}

// The website's 1-5 novelty buckets are minimums ("4+" includes 5/5 posts):
// bucket N maps to a floor on novelty_score. Bucket 1 has no floor.
const NOVELTY_BUCKET_MIN = { 2: 21, 3: 41, 4: 71, 5: 91 };

// Floor for a bucket, or undefined for bucket 1 / no bucket / junk input.
function noveltyBucketMin(bucket) {
  return NOVELTY_BUCKET_MIN[Number(bucket)];
}

// Inverse: which 1-5 bucket a 0-100 score falls in.
function noveltyBucketOf(score) {
  let bucket = 1;
  for (const [b, min] of Object.entries(NOVELTY_BUCKET_MIN)) {
    if (score >= min) bucket = Number(b);
  }
  return bucket;
}

// Longer search strings are truncated; ILIKE over several columns gets slow.
const MAX_SEARCH_LENGTH = 200;

/**
 * WHERE clause shared by every list endpoint: /api/v1/posts, the legacy
 * /api/content, /api/source-stats, /api/content/export, /rss.xml and the
 * email digest. Throws ValidationError on bad input.
 */
function buildV1Where(q) {
  const clauses = [];
  const params = [];
  const add = (val, sql) => {
    params.push(val);
    clauses.push(sql(params.length));
  };

  const search = scalarParam(q, "search")?.slice(0, MAX_SEARCH_LENGTH);
  if (search) {
    add(
      `%${search}%`,
      (i) => `(
        title ILIKE $${i} OR cleaned_title ILIKE $${i} OR
        sentence_summary ILIKE $${i} OR paragraph_summary ILIKE $${i} OR
        key_implication ILIKE $${i} OR cluster_tag ILIKE $${i} OR
        array_to_string(authors, ' ') ILIKE $${i} OR
        array_to_string(topics, ' ') ILIKE $${i}
      )`
    );
  }

  // source_type: exact names, repeat the key for several. sources: the
  // website's comma-separated form, kept as an alias.
  const sources = [
    ...listParam(q, "source_type", { split: false }),
    ...listParam(q, "sources", { split: true }),
  ];
  if (sources.length) add(sources, (i) => `source_type = ANY($${i}::text[])`);

  const tags = listParam(q, "tags", { split: true }).map((t) => t.toLowerCase());
  if (tags.length) add(tags, (i) => `LOWER(cluster_tag) = ANY($${i}::text[])`);

  const topics = listParam(q, "topics", { split: true }).map((t) => t.toLowerCase());
  if (topics.length) {
    add(
      topics,
      (i) => `EXISTS (SELECT 1 FROM unnest(topics) AS t WHERE LOWER(t) = ANY($${i}::text[]))`
    );
  }

  const noveltyMin = numberParam(q, "novelty_min");
  if (noveltyMin !== undefined) add(noveltyMin, (i) => `novelty_score >= $${i}`);
  const noveltyMax = numberParam(q, "novelty_max");
  if (noveltyMax !== undefined) add(noveltyMax, (i) => `novelty_score <= $${i}`);

  const after = dateParam(q, "published_after");
  if (after) add(after, (i) => `published_date >= $${i}`);
  const before = dateParam(q, "published_before");
  if (before) add(before, (i) => `published_date < $${i}`);

  return {
    whereSQL: clauses.length ? "WHERE " + clauses.join(" AND ") : "",
    params,
  };
}

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
app.get("/api/v1/posts/sources", async (_req, res) => {
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
app.get("/api/v1/posts/tags", async (_req, res) => {
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
app.get("/api/v1/posts/topics", async (req, res) => {
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
app.get("/api/v1/posts/stats", async (_req, res) => {
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
app.get("/api/v1/posts", async (req, res) => {
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
app.get("/api/v1/posts/by-uuid/:uuid", (req, res) => {
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
app.get("/api/v1/posts/:id", (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: "id must be a non-negative integer" });
  }
  const id = Number(req.params.id);
  if (id > PG_INT4_MAX) return res.status(404).json({ error: "Post not found" });
  return sendSinglePost(res, "id = $1", id, "GET /api/v1/posts/:id");
});

// ---------------------------------------------------------------------------
// RSS feed
// ---------------------------------------------------------------------------

const SITE_URL = "https://aisafetyfeed.com";

// Characters XML 1.0 forbids even inside CDATA (control chars, lone
// surrogates). A single one anywhere makes the whole feed unparseable.
const XML_INVALID_CHARS = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
const xmlSafe = (s) => String(s ?? "").replace(XML_INVALID_CHARS, "");
const xmlText = (s) => escapeHtml(xmlSafe(s));
const cdata = (s) => `<![CDATA[${xmlSafe(s).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

// The paragraph summaries are light markdown: blank-line paragraphs, "* "
// bullets and **bold**. Render just that much into HTML for feed readers.
function summaryMarkdownToHtml(text) {
  if (!text) return "";
  const out = [];
  let para = [];
  let inList = false;
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join(" ")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (inList) out.push("</ul>");
    inList = false;
  };
  for (const raw of escapeHtml(String(text)).split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = line.match(/^[*\-]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!inList) out.push("<ul>");
      inList = true;
      out.push(`<li>${bullet[1]}</li>`);
    } else if (!line) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out.join("\n").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function buildRssXml({ title, description, selfUrl, posts }) {
  const items = posts
    .map((p) => {
      const displayTitle = getDisplayTitle(p);
      const similarUrl = generateSimilarUrl(p, SITE_URL);
      const authors = (p.authors || []).filter(Boolean);
      const categories = [p.cluster_tag, ...(p.topics || [])].filter(Boolean);

      const body = [];
      if (p.sentence_summary) {
        body.push(`<p><strong>${escapeHtml(p.sentence_summary)}</strong></p>`);
      }
      if (p.paragraph_summary) body.push(summaryMarkdownToHtml(p.paragraph_summary));
      if (p.key_implication) {
        body.push(`<p><em>Key implication:</em> ${escapeHtml(p.key_implication)}</p>`);
      }
      const meta = [];
      if (p.source_type) meta.push(escapeHtml(p.source_type));
      if (authors.length) meta.push(escapeHtml(authors.join(", ")));
      if (p.novelty_score != null) meta.push(`Novelty ${Math.round(p.novelty_score)}/100`);
      meta.push(`<a href="${escapeHtml(similarUrl)}">Similar posts on AI Safety Feed</a>`);
      body.push(`<p><small>${meta.join(" | ")}</small></p>`);

      return [
        "    <item>",
        `      <title>${xmlText(displayTitle)}</title>`,
        `      <link>${xmlText(p.source_url || similarUrl)}</link>`,
        `      <guid isPermaLink="false">${xmlText(p.uuid || `aisafetyfeed-content-${p.id}`)}</guid>`,
        p.published_date
          ? `      <pubDate>${new Date(p.published_date).toUTCString()}</pubDate>`
          : null,
        authors.length ? `      <dc:creator>${xmlText(authors.join(", "))}</dc:creator>` : null,
        ...categories.map((c) => `      <category>${xmlText(c)}</category>`),
        `      <description>${xmlText(p.sentence_summary || p.key_implication || "")}</description>`,
        `      <content:encoded>${cdata(body.join("\n"))}</content:encoded>`,
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  // Derive lastBuildDate from the data, not the clock, so an unchanged feed
  // produces byte-identical output and feed readers get 304s from the ETag.
  const newest = posts.reduce((acc, p) => {
    const t = new Date(p.updated_at || p.created_at || p.published_date || 0).getTime();
    return Number.isFinite(t) && t > acc ? t : acc;
  }, 0);
  const lastBuild = new Date(newest || Date.now()).toUTCString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xmlText(title)}</title>
    <link>${SITE_URL}</link>
    <description>${xmlText(description)}</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <ttl>60</ttl>
    <atom:link href="${xmlText(selfUrl)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

/**
 * @swagger
 * /rss.xml:
 *   get:
 *     summary: RSS 2.0 feed of the latest posts
 *     description: |
 *       Subscribe in any feed reader. Accepts the same filters as /api/v1/posts, so you can build a feed for one source or tag, e.g. `/rss.xml?source_type=Less Wrong` or `/rss.xml?tags=technical ml safety&novelty_min=60`.
 *       Items are ordered by when they were added to the feed (so a podcast transcribed a few days late still shows up), each links to the original post, and the body carries the AI-generated summaries. Also served at `/feed.xml`.
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
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *     responses:
 *       200:
 *         description: RSS document
 *         content:
 *           application/rss+xml:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid parameter value
 */
async function rssHandler(req, res) {
  try {
    const { whereSQL, params } = buildV1Where(req.query);
    const limit = intParam(req.query, "limit", 50, 1, 100);

    const apiBase = (
      process.env.API_BASE_URL ||
      process.env.BACKEND_URL ||
      `${req.protocol}://${req.get("host")}`
    ).replace(/\/$/, "");

    const sources = [
      ...listParam(req.query, "source_type", { split: false }),
      ...listParam(req.query, "sources", { split: true }),
    ];
    const tags = listParam(req.query, "tags", { split: true });
    let title = "AI Safety Feed";
    if (sources.length) title += ` - ${sources.join(", ")}`;
    if (tags.length) title += ` - ${tags.join(", ")}`;

    // id is a serial, so id DESC is ingestion order.
    const { rows } = await pool.query(
      `SELECT ${V1_POST_COLS} FROM content ${whereSQL}
       ORDER BY id DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    const xml = buildRssXml({
      title,
      description:
        "Curated AI safety posts, papers, newsletters and podcast episodes with AI-generated summaries and novelty scores.",
      selfUrl: apiBase + req.originalUrl,
      posts: rows,
    });
    res.set("Content-Type", "application/rss+xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=900");
    res.send(xml);
  } catch (err) {
    sendError(res, err, "GET /rss.xml");
  }
}
app.get("/rss.xml", rssHandler);
app.get("/feed.xml", rssHandler);

// --- Email Subscription Endpoints ---

// POST /api/subscribe
app.post("/api/subscribe", async (req, res) => {
  const { email, frequency = "daily", filters = {} } = req.body;

  // Basic Validation
  if (
    !email ||
    typeof email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  ) {
    return res.status(400).json({ error: "Valid email address is required." });
  }
  if (!["daily", "weekly"].includes(frequency)) {
    return res
      .status(400)
      .json({ error: "Invalid frequency. Must be 'daily' or 'weekly'." });
  }
  if (typeof filters !== "object" || filters === null) {
    return res
      .status(400)
      .json({ error: "Filters must be a valid JSON object." });
  }
  // Validate novelty within filters
  if (
    filters.novelty !== null &&
    filters.novelty !== undefined &&
    (!Number.isInteger(filters.novelty) ||
      filters.novelty < 1 ||
      filters.novelty > 5)
  ) {
    return res.status(400).json({
      error: "Novelty filter must be null or an integer between 1 and 5.",
    });
  }

  try {
    const newUnsubscribeToken = uuidv4();

    const query = `
      INSERT INTO email_subscriptions (email, frequency, filters, unsubscribe_token, is_active, last_sent_at)
      VALUES ($1, $2, $3, $4, TRUE, NULL)
      ON CONFLICT (email) DO UPDATE
      SET frequency = EXCLUDED.frequency,
          filters = EXCLUDED.filters,
          unsubscribe_token = EXCLUDED.unsubscribe_token,
          is_active = TRUE, -- Reactivate on resubscribe
          last_sent_at = NULL -- Reset last sent time on update
      RETURNING id, email, frequency, is_active;
    `;
    const params = [
      email,
      frequency,
      JSON.stringify(filters),
      newUnsubscribeToken,
    ];

    const { rows } = await pool.query(query, params);

    console.log(`Subscription created/updated for: ${email}`);
    return res
      .status(201)
      .json({ message: "Subscription successful!", subscription: rows[0] });
  } catch (err) {
    console.error("Error in /api/subscribe:", err);
    // Check for specific DB errors if needed, e.g., constraint violations not handled by ON CONFLICT
    res.status(500).json({ error: "Failed to update subscription." });
  }
});

// GET /api/unsubscribe/:token
app.get("/api/unsubscribe/:token", async (req, res) => {
  const { token } = req.params;

  // Basic UUID format check (doesn't guarantee validity)
  if (
    !token ||
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      token
    )
  ) {
    return res.status(400).send(`
      <html><body>
        <h1>Invalid Unsubscribe Link</h1>
        <p>The unsubscribe link format is incorrect. Please check the link or contact support.</p>
      </body></html>
    `);
  }

  try {
    const query = `
      UPDATE email_subscriptions
      SET is_active = FALSE
      WHERE unsubscribe_token = $1 AND is_active = TRUE
      RETURNING email;
    `;
    const { rows, rowCount } = await pool.query(query, [token]);

    if (rowCount > 0) {
      console.log(`Unsubscribed: ${rows[0].email}`);
      res.status(200).send(`
        <html><body>
          <h1>Unsubscribed Successfully</h1>
          <p>You have been successfully unsubscribed from email digests.</p>
        </body></html>
      `);
    } else {
      console.log(
        `Unsubscribe attempt failed: Token ${token} not found or already inactive.`
      );
      res.status(404).send(`
        <html><body>
          <h1>Unsubscribe Failed</h1>
          <p>This unsubscribe link is invalid or you are already unsubscribed.</p>
        </body></html>
      `);
    }
  } catch (err) {
    console.error(`Error in /api/unsubscribe/${token}:`, err);
    res.status(500).send(`
      <html><body>
        <h1>Server Error</h1>
        <p>An error occurred while processing your unsubscribe request. Please try again later.</p>
      </body></html>
    `);
  }
});

// Single post by id, without the article body (the old Similar page's
// reference card). The new frontend uses /api/v1/posts/:id instead.
// NOTE: This must come *after* /api/content/by-ids and /export to avoid conflict
app.get("/api/content/:id", async (req, res) => {
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

// --- Scheduled Tasks for Email Digests ---

// Refactored function to process subscriptions and send in batches
async function processSubscriptionsAndSendBatches() {
  // Ensure Postmark client is available
  if (!postmarkClient) {
    console.error(
      `[CronJob/DigestBatch] Postmark client not initialized. Skipping job.`
    );
    return;
  }

  console.log(`[CronJob/DigestBatch] Starting batch processing job.`);
  let subscriptions = [];
  try {
    const { rows } = await pool.query(
      "SELECT * FROM email_subscriptions WHERE is_active = TRUE ORDER BY id" // Fetch all active
    );
    subscriptions = rows;
  } catch (err) {
    console.error(`[CronJob/DigestBatch] Error fetching subscriptions:`, err);
    return;
  }

  console.log(
    `[CronJob/DigestBatch] Found ${subscriptions.length} active subscriptions.`
  );

  const now = new Date(); // Get current time
  // Use Eastern Time for day-of-week check to match cron schedule timezone
  const easternTimeString = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
  });
  const easternDate = new Date(easternTimeString);
  const dayOfWeekET = easternDate.getDay(); // 0 = Sunday, ..., 6 = Saturday (Eastern Time)
  const nowUtcMillis = now.getTime(); // Current time in UTC milliseconds
  const messagesToSend = []; // Array to hold all message objects for the batch
  const subscriptionsToUpdateTimestamp = []; // IDs of subs where email is sent
  const subscriptionsToUpdateTimestampNoContent = []; // IDs of subs with no new content

  // --- 1. Prepare messages for all eligible subscriptions ---
  for (const sub of subscriptions) {
    let shouldProcess = false;
    if (sub.frequency === "daily") {
      shouldProcess = true;
    } else if (sub.frequency === "weekly" && dayOfWeekET === 1) {
      // Weekly on Monday (Eastern Time) - now consistent with cron schedule
      shouldProcess = true;
    }

    // Skip if sent recently (e.g., within ~24 hours), comparing UTC times
    if (shouldProcess && sub.last_sent_at) {
      const lastSentUtc = new Date(sub.last_sent_at).getTime(); // Get UTC milliseconds from DB timestamp
      // Threshold: ~23 hours and 59 minutes ago in UTC milliseconds
      const thresholdMillisAgo =
        nowUtcMillis - (23 * 3600 * 1000 + 59 * 60 * 1000);

      if (lastSentUtc > thresholdMillisAgo) {
        console.log(
          `[CronJob/DigestBatch] Skipping ${sub.email} (ID: ${sub.id}) - sent recently (UTC check).`
        );
        shouldProcess = false; // Override processing if sent recently
      }
    }

    if (shouldProcess) {
      console.log(
        `[CronJob/DigestBatch] Preparing ${sub.frequency} digest for ${sub.email} (ID: ${sub.id})`
      );
      const newContent = await fetchContentForSubscription(sub);

      if (newContent === null) {
        // Error occurred during fetch, skip this sub for now
        console.error(
          `[CronJob/DigestBatch] Skipping ${sub.email} due to content fetch error.`
        );
        continue;
      }

      if (newContent.length > 0) {
        // Create preheader text
        const preheaderStats = [];
        const sourceTypes = [
          ...new Set(newContent.map((c) => c.source_type)),
        ].filter(Boolean);
        preheaderStats.push(`${newContent.length} new posts`);
        if (sourceTypes.length > 0) {
          preheaderStats.push(`from ${sourceTypes.slice(0, 3).join(", ")}`);
        }
        const preheaderText = preheaderStats.join(" ");

        const htmlBody = generateDigestHtml(sub, newContent);

        // Add hidden preheader span at the very beginning of the HTML
        const htmlWithPreheader = htmlBody
          .replace(
            "<html>",
            `<html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>`
          )
          .replace(
            '<body style="font-family: sans-serif; color: #333;">',
            `<body style="font-family: sans-serif; color: #333;">
          <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">
            ${escapeHtml(preheaderText)}
            &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
          </div>
          <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">
            &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
          </div>`
          );

        messagesToSend.push({
          From: "AI Safety Feed <digest@aisafetyfeed.com>",
          To: sub.email,
          Subject: `Your ${
            sub.frequency
          } AI Safety Feed Digest - ${now.toLocaleDateString()}`,
          HtmlBody: htmlWithPreheader,
          MessageStream: "broadcast",
          Tag: `${sub.frequency}-digest`,
        });
        // Mark for timestamp update *after* successful sending
        // subscriptionsToUpdateTimestamp.push(sub.id); // We'll add this based on batch response
      } else {
        console.log(
          `[CronJob/DigestBatch] No new content for ${sub.email} (ID: ${sub.id}). Marking for timestamp update.`
        );
        subscriptionsToUpdateTimestampNoContent.push(sub.id);
      }
    }
  }

  // --- 2. Send prepared messages in batches ---
  const BATCH_SIZE = 500; // Postmark limit
  console.log(
    `[CronJob/DigestBatch] Prepared ${messagesToSend.length} emails to send.`
  );

  for (let i = 0; i < messagesToSend.length; i += BATCH_SIZE) {
    const batch = messagesToSend.slice(i, i + BATCH_SIZE);
    // Need to map batch back to subscription IDs for timestamp updates

    if (batch.length > 0) {
      console.log(
        `[CronJob/DigestBatch] Sending batch ${i / BATCH_SIZE + 1} with ${
          batch.length
        } emails...`
      );
      try {
        // Ensure postmarkClient is defined and has sendEmailBatch
        if (
          postmarkClient &&
          typeof postmarkClient.sendEmailBatch === "function"
        ) {
          const results = await postmarkClient.sendEmailBatch(batch);
          console.log(
            `[CronJob/DigestBatch] Batch ${
              i / BATCH_SIZE + 1
            } sent.` /* Results: ${JSON.stringify(results)}` */
          );

          // Process results to find successful sends for timestamp update
          results.forEach((result, index) => {
            const correspondingMessage = batch[index]; // Message from the sent batch
            const correspondingSub = subscriptions.find(
              (s) => s.email === correspondingMessage.To
            ); // Find the subscription by email

            if (correspondingSub) {
              // Add to timestamp update list regardless of send success or failure
              subscriptionsToUpdateTimestamp.push(correspondingSub.id);

              if (result.ErrorCode !== 0) {
                // Log details if the send failed
                console.error(
                  `[CronJob/DigestBatch] Failed to send to ${result.To} (Sub ID: ${correspondingSub.id}). ErrorCode: ${result.ErrorCode}, Message: ${result.Message}. 'last_sent_at' will still be updated.`
                );
              }
              // Success case: (result.ErrorCode === 0). No specific logging for success is added here,
              // but can be if desired. The primary goal is that last_sent_at is updated.
            } else {
              // This case means we couldn't map the email from the batch result back to a known subscription.
              // The send might have succeeded or failed for this recipient.
              console.warn(
                `[CronJob/DigestBatch] Could not find subscription for email ${result.To} from Postmark batch result. Send status: ErrorCode ${result.ErrorCode}, Message: ${result.Message}. 'last_sent_at' will not be updated for this entry.`
              );
            }
          });
        } else {
          console.error(
            "[CronJob/DigestBatch] Postmark client or sendEmailBatch method is not available."
          );
          // Optionally handle this case, maybe skip the batch or throw an error
        }
      } catch (err) {
        console.error(
          `[CronJob/DigestBatch] Error sending batch ${i / BATCH_SIZE + 1}:`,
          err
        );
        // Decide how to handle batch errors - potentially retry later?
        // For now, we log and continue, timestamps won't be updated for this failed batch.
      }
    }
  }

  // --- 3. Update timestamps ---
  const uniqueSuccessfulIds = [...new Set(subscriptionsToUpdateTimestamp)]; // Ensure uniqueness
  if (uniqueSuccessfulIds.length > 0) {
    console.log(
      `[CronJob/DigestBatch] Updating last_sent_at for ${uniqueSuccessfulIds.length} successfully sent subscriptions.`
    );
    try {
      await pool.query(
        "UPDATE email_subscriptions SET last_sent_at = NOW() WHERE id = ANY($1::int[])",
        [uniqueSuccessfulIds]
      );
    } catch (updateErr) {
      console.error(
        `[CronJob/DigestBatch] Error updating last_sent_at for successful sends:`,
        updateErr
      );
    }
  }

  if (subscriptionsToUpdateTimestampNoContent.length > 0) {
    console.log(
      `[CronJob/DigestBatch] Updating last_sent_at for ${subscriptionsToUpdateTimestampNoContent.length} subscriptions with no new content.`
    );
    try {
      await pool.query(
        "UPDATE email_subscriptions SET last_sent_at = NOW() WHERE id = ANY($1::int[])",
        [subscriptionsToUpdateTimestampNoContent]
      );
    } catch (updateErr) {
      console.error(
        `[CronJob/DigestBatch] Error updating last_sent_at for no-content sends:`,
        updateErr
      );
    }
  }

  console.log(`[CronJob/DigestBatch] Finished batch processing job.`);
}

// --- Schedule the Batch Job ---
const isDevelopment = process.env.NODE_ENV === "development";
const cronSchedule = isDevelopment ? "* * * * *" : "0 8 * * *"; // Every minute in dev, 8 AM ET otherwise
const scheduleOptions = { timezone: "America/New_York" };

console.log(
  `Scheduling email digest job with schedule "${cronSchedule}" ${
    isDevelopment ? "(DEV mode)" : "(PROD mode)"
  }`
);

cron.schedule(
  cronSchedule,
  () => {
    console.log(
      `Running Batched Email Digest Task (${
        isDevelopment ? "every minute" : "Daily @ 8 AM ET"
      })`
    );
    processSubscriptionsAndSendBatches();
  },
  scheduleOptions
);

console.log(`Batched email digest cron job scheduled.`);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
