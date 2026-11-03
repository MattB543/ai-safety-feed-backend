// RSS feed and sitemap.

const express = require("express");
const { pool } = require("../db");
const {
  V1_POST_COLS,
  sendError,
  listParam,
  intParam,
  buildV1Where,
} = require("../params");
const {
  escapeHtml,
  getDisplayTitle,
  generateSimilarUrl,
  FRONTEND_URL,
} = require("../util");

const router = express.Router();

// ---------------------------------------------------------------------------
// RSS feed
// ---------------------------------------------------------------------------

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
      const similarUrl = generateSimilarUrl(p, FRONTEND_URL);
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
    <link>${FRONTEND_URL}</link>
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
router.get("/rss.xml", rssHandler);
router.get("/feed.xml", rssHandler);

// ---------------------------------------------------------------------------
// Sitemap. Netlify proxies https://aisafetyfeed.com/sitemap.xml here, so all
// URLs are on FRONTEND_URL: the static pages plus every post's /similar page.
// ---------------------------------------------------------------------------

const SITEMAP_PAGES = ["/", "/about", "/digest", "/data"];
// A sitemap file may list at most 50,000 URLs.
const SITEMAP_MAX_POSTS = 50000 - SITEMAP_PAGES.length;

router.get("/sitemap.xml", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, cleaned_title, COALESCE(updated_at, created_at) AS lastmod
         FROM content
        ORDER BY id DESC
        LIMIT $1`,
      [SITEMAP_MAX_POSTS]
    );
    const url = (loc, lastmod) =>
      `  <url><loc>${xmlText(loc)}</loc>${
        lastmod ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : ""
      }</url>`;
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...SITEMAP_PAGES.map((p) => url(FRONTEND_URL + p)),
      ...rows.map((r) => url(generateSimilarUrl(r, FRONTEND_URL), r.lastmod)),
      "</urlset>",
      "",
    ].join("\n");
    res.set("Content-Type", "application/xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(xml);
  } catch (err) {
    sendError(res, err, "GET /sitemap.xml");
  }
});

module.exports = router;
