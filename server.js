const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Parser } = require("json2csv");
const fs = require("fs");
const postmark = require("postmark");
const { v4: uuidv4 } = require("uuid");
const cron = require("node-cron"); // Import node-cron

const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_FREE_CREDITS_KEY,
});
const GPT_MODEL = "gpt-4.1";

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
        maxScore = 90;
        break;
      case 5:
        minScore = 91;
        maxScore = 100;
        break;
      // case 1 and default: minScore = 0, maxScore = 20
      case 1:
        minScore = 0;
        maxScore = 20;
        break;
    }

    // Add condition for exclusive bucket range
    conditions.push(
      `novelty_score >= $${finalParams.length + 1} AND novelty_score <= $${
        finalParams.length + 2
      }`
    );
    finalParams.push(minScore);
    finalParams.push(maxScore);
  }

  let query = `SELECT
    id, title, sentence_summary, paragraph_summary, key_implication,
    novelty_score, novelty_note,
    image_url, source_url, source_type,
    authors, topics, cluster_tag, published_date,
    cleaned_title, cleaned_image, image_prompt
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
        WHERE id <> $3 AND embedding_short IS NOT NULL
    ORDER BY embedding_short <=> $1
        LIMIT $2)
      UNION ALL
      (SELECT *, embedding_full  <=> $4 AS dist
        FROM content
        WHERE id <> $3 AND embedding_full IS NOT NULL
    ORDER BY embedding_full  <=> $4
        LIMIT $2)
      `,
    [ref.embedding_short, k, id, ref.embedding_full]
  );
  console.log(
    `[findVectorSimilarCandidates/${id}] Found ${cands.length} candidates before deduplication.`
  );

  // Deduplicate candidates based on ID, keeping the entry with the MINIMUM distance
  const uniqueCandsMap = new Map();
  cands.forEach((cand) => {
    const existingCand = uniqueCandsMap.get(cand.id);
    if (!existingCand || cand.dist < existingCand.dist) {
      uniqueCandsMap.set(cand.id, cand);
    }
  });
  const uniqueCands = Array.from(uniqueCandsMap.values());
  console.log(
    `[findVectorSimilarCandidates/${id}] Deduplicated to ${uniqueCands.length} unique candidates (kept version with min distance).`
  );

  return { ref, candidates: uniqueCands, error: null, status: 200 };
}

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

    /* ---------- 2. GPT re-rank ---------- */
    let finalIds = [];
    if (openai && GPT_MODEL && uniqueCands.length > 0) {
      const prompt = buildRerankPrompt(ref, uniqueCands);
      console.log(
        `[similar/${id}/ai] Sending prompt to OpenAI for reranking ${uniqueCands.length} candidates down to ${n}...`
      );
      // console.log(`[similar/${id}/ai] OpenAI Prompt:\n${prompt}`); // Uncomment for full prompt

      try {
        const resp = await openai.chat.completions.create({
          model: GPT_MODEL,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "You are a 'Post Similarity Ranking' service that returns ONLY a JSON array of candidate IDs.",
            },
            { role: "user", content: prompt },
          ],
        });
        const openaiResponseText = resp.choices[0].message.content;
        console.log(
          `[similar/${id}/ai] OpenAI raw response: ${openaiResponseText}`
        );

        // Extract the JSON array part robustly
        const jsonMatch = openaiResponseText.match(/(\[[\s\S]*?\])/); // More robust regex to find the array
        if (jsonMatch && jsonMatch[1]) {
          try {
            finalIds = JSON.parse(jsonMatch[1]);
            // Ensure we only take up to 'n' results from AI
            if (finalIds.length > n) {
              console.warn(
                `[similar/${id}/ai] OpenAI returned ${finalIds.length} IDs, truncating to ${n}.`
              );
              finalIds = finalIds.slice(0, n);
            }
            console.log(
              `[similar/${id}/ai] Parsed OpenAI IDs (${
                finalIds.length
              }): ${JSON.stringify(finalIds)}`
            );
          } catch (parseError) {
            console.error(
              `[similar/${id}/ai] Failed to parse JSON from OpenAI response: "${jsonMatch[1]}"`,
              parseError
            );
            return res
              .status(500)
              .json({ error: "AI response was not valid JSON." });
          }
        } else {
          console.warn(
            `[similar/${id}/ai] No valid JSON array found in OpenAI response: "${openaiResponseText}"`
          );
          // Fallback will be triggered if no JSON array is found by the regex
        }
      } catch (e) {
        console.error(
          `[similar/${id}/ai] OpenAI call or JSON parse failed:`,
          e
        );
        // Fallback will be triggered below
      }
    } else if (uniqueCands.length === 0) {
      console.log(`[similar/${id}/ai] No candidates found for AI reranking.`);
    } else {
      console.log(
        `[similar/${id}/ai] OpenAI client/model not configured or no candidates, skipping rerank.`
      );
    }

    // 3. Fallback or use vector order if OpenAI missing / failed / no candidates initially
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

// --- NEW PUBLIC API ENDPOINTS FOR POSTS TABLE ---

/**
 * @swagger
 * /api/v1/posts/sources:
 *   get:
 *     summary: Get all unique source types
 *     tags: [Metadata]
 *     responses:
 *       200:
 *         description: List of source types
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *               example: ["EA Forum", "LessWrong", "Alignment Forum"]
 */
app.get("/api/v1/posts/sources", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT DISTINCT source_type FROM posts WHERE source_type IS NOT NULL ORDER BY source_type"
    );
    res.json(rows.map((r) => r.source_type));
  } catch (err) {
    console.error("Error fetching sources:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /api/v1/posts/tags:
 *   get:
 *     summary: Get all unique tags with counts
 *     tags: [Metadata]
 *     responses:
 *       200:
 *         description: List of tags with post counts
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
app.get("/api/v1/posts/tags", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT tag, COUNT(*)::int as count
      FROM posts, unnest(feed_tags) as tag
      WHERE tag IS NOT NULL
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching tags:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /api/v1/posts/stats:
 *   get:
 *     summary: Get statistics about the posts
 *     tags: [Metadata]
 *     responses:
 *       200:
 *         description: Statistics about posts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total_posts:
 *                   type: integer
 *                 sources:
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
 *                 avg_reading_time:
 *                   type: number
 */
app.get("/api/v1/posts/stats", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        COUNT(*)::int as total_posts,
        COUNT(DISTINCT source_type)::int as sources,
        MIN(published_date) as earliest,
        MAX(published_date) as latest,
        AVG(reading_time_minutes)::float as avg_reading_time
      FROM posts
    `);

    res.json({
      total_posts: rows[0].total_posts,
      sources: rows[0].sources,
      date_range: {
        earliest: rows[0].earliest,
        latest: rows[0].latest,
      },
      avg_reading_time: rows[0].avg_reading_time,
    });
  } catch (err) {
    console.error("Error fetching stats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * components:
 *   schemas:
 *     Post:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Unique identifier
 *         uuid:
 *           type: string
 *           format: uuid
 *         title:
 *           type: string
 *         source_url:
 *           type: string
 *           format: uri
 *         source_type:
 *           type: string
 *           example: "EA Forum"
 *         published_date:
 *           type: string
 *           format: date-time
 *         authors_display:
 *           type: array
 *           items:
 *             type: string
 *         short_summary:
 *           type: string
 *         long_summary:
 *           type: string
 *         key_implication:
 *           type: string
 *         novelty_score:
 *           type: number
 *           minimum: 0
 *           maximum: 100
 *         feed_tags:
 *           type: array
 *           items:
 *             type: string
 *         reading_time_minutes:
 *           type: integer
 *         word_count:
 *           type: integer
 */

/**
 * @swagger
 * /api/v1/posts:
 *   get:
 *     summary: Get posts with filtering and pagination
 *     description: Retrieve AI safety posts from various sources with optional filtering
 *     tags: [Posts]
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in title, summary, and authors
 *       - in: query
 *         name: source_type
 *         schema:
 *           type: string
 *         description: Filter by source (e.g., "EA Forum", "LessWrong")
 *       - in: query
 *         name: tags
 *         schema:
 *           type: string
 *         description: Comma-separated list of feed tags
 *       - in: query
 *         name: novelty_min
 *         schema:
 *           type: integer
 *           minimum: 0
 *           maximum: 100
 *         description: Minimum novelty score
 *       - in: query
 *         name: published_after
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter posts published after this date
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
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
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 */
app.get("/api/v1/posts", async (req, res) => {
  try {
    const {
      search,
      source_type,
      tags,
      novelty_min,
      published_after,
      limit = 20,
      offset = 0,
    } = req.query;

    // Build query
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    // Search filter
    if (search) {
      conditions.push(`(
        title ILIKE $${paramIndex} OR 
        short_summary ILIKE $${paramIndex} OR 
        long_summary ILIKE $${paramIndex} OR
        array_to_string(authors_display, ' ') ILIKE $${paramIndex}
      )`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Source type filter
    if (source_type) {
      conditions.push(`source_type = $${paramIndex}`);
      params.push(source_type);
      paramIndex++;
    }

    // Tags filter
    if (tags) {
      const tagList = tags.split(",").map((t) => t.trim());
      conditions.push(`feed_tags && $${paramIndex}::text[]`);
      params.push(tagList);
      paramIndex++;
    }

    // Novelty score filter
    if (novelty_min) {
      conditions.push(`novelty_score >= $${paramIndex}`);
      params.push(parseInt(novelty_min));
      paramIndex++;
    }

    // Date filter
    if (published_after) {
      conditions.push(`published_date >= $${paramIndex}`);
      params.push(published_after);
      paramIndex++;
    }

    // Build final query
    let query = "SELECT * FROM posts";
    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += ` ORDER BY published_date DESC LIMIT $${paramIndex} OFFSET $${
      paramIndex + 1
    }`;
    params.push(parseInt(limit), parseInt(offset));

    // Get total count
    let countQuery = "SELECT COUNT(*) FROM posts";
    if (conditions.length > 0) {
      countQuery += " WHERE " + conditions.join(" AND ");
    }
    const countParams = params.slice(0, -2); // Remove limit and offset

    // Execute queries
    const [dataResult, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams),
    ]);

    const total = parseInt(countResult.rows[0].count);

    res.json({
      data: dataResult.rows,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: offset + limit < total,
      },
    });
  } catch (err) {
    console.error("Error fetching posts:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /api/v1/posts/{id}:
 *   get:
 *     summary: Get a single post by ID
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Post ID
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       404:
 *         description: Post not found
 */
app.get("/api/v1/posts/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM posts WHERE id = $1", [
      req.params.id,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching post:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @swagger
 * /api/v1/posts/by-uuid/{uuid}:
 *   get:
 *     summary: Get a single post by UUID
 *     tags: [Posts]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Post UUID
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Post'
 *       404:
 *         description: Post not found
 */
app.get("/api/v1/posts/by-uuid/:uuid", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM posts WHERE uuid = $1", [
      req.params.uuid,
    ]);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching post by UUID:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Email Subscription Endpoints ---

// POST /api/subscribe
app.post("/api/subscribe", async (req, res) => {
  const { email, frequency = "daily", filters = {} } = req.body;

  // Basic Validation
  if (
    !email ||
    typeof email !== "string" ||
    !/^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$/.test(email)
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
    } else if (sub.frequency === "weekly" && dayOfWeekET === 2) {
      // Weekly on Tuesday (Eastern Time) - now consistent with cron schedule
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

// Start the server and listen on the defined port
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
