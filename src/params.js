// Query-parameter parsing and the shared WHERE builder. Every list endpoint
// (the v1 API, the website's legacy endpoints, the CSV export, RSS and the
// email digest) filters through buildV1Where so they all behave the same.

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

module.exports = {
  V1_POST_FIELDS,
  selectCols,
  V1_POST_COLS,
  V1_POST_COLS_WITH_CONTENT,
  V1_SORTS,
  PG_INT4_MAX,
  UUID_RE,
  ValidationError,
  sendError,
  scalarParam,
  listParam,
  boolParam,
  intParam,
  numberParam,
  dateParam,
  sortParam,
  NOVELTY_BUCKET_MIN,
  noveltyBucketMin,
  noveltyBucketOf,
  MAX_SEARCH_LENGTH,
  buildV1Where,
};
