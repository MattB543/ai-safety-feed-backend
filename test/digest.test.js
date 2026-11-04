// Digest query and HTML, against a stubbed pool. Nothing is sent.
const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db");
const {
  fetchContentForSubscription,
  generateDigestHtml,
  feedUrlForFilters,
} = require("../src/digest");

const sub = {
  email: "reader@example.com",
  frequency: "daily",
  unsubscribe_token: "00000000-0000-4000-8000-000000000000",
  last_sent_at: "2026-11-01T08:00:00Z",
  filters: { searchTerm: null, sources: ["80,000 Hours Podcast"], tags: ["AI Safety"], novelty: 3 },
};

const post = (id) => ({
  id,
  title: `Post ${id}`,
  source_url: `https://example.com/${id}`,
  source_type: "80,000 Hours Podcast",
  published_date: "2026-11-02T00:00:00Z",
  sentence_summary: "Summary",
  novelty_score: 50,
});

test("fetchContentForSubscription filters like the site and counts past 20", async () => {
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 37 }] };
    return { rows: Array.from({ length: 20 }, (_, i) => post(i + 1)) };
  };
  const { rows, total } = await fetchContentForSubscription(sub);
  assert.equal(rows.length, 20);
  assert.equal(total, 37);
  assert.equal(calls.length, 2);
  const [select] = calls;
  assert.deepEqual(select.params.slice(0, 3), [["80,000 Hours Podcast"], ["ai safety"], 41]);
  assert.ok(select.params[3] instanceof Date);
  assert.match(select.sql, /AND created_at > \$4/);
  assert.match(select.sql, /LIMIT 20/);
});

test("fetchContentForSubscription skips the count for a short page", async () => {
  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [post(1)] };
  };
  const { rows, total } = await fetchContentForSubscription({ ...sub, filters: {} });
  assert.equal(rows.length, 1);
  assert.equal(total, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE created_at > \$1/);
});

test("the digest links to the full feed only when posts were left out", () => {
  const rows = [post(1), post(2)];
  const full = generateDigestHtml(sub, rows, 2);
  assert.doesNotMatch(full, /See all/);
  const partial = generateDigestHtml(sub, rows, 37);
  assert.match(partial, /See all 37 new posts/);
  assert.ok(partial.includes(feedUrlForFilters(sub.filters).replace(/&/g, "&amp;")));
  assert.ok(partial.includes("https://aisafetyfeed.com/similar/post-1-1"));
  assert.ok(partial.includes(`/api/unsubscribe/${sub.unsubscribe_token}`));
});

test("feedUrlForFilters builds the website's feed URL", () => {
  assert.equal(feedUrlForFilters({}), "https://aisafetyfeed.com/");
  assert.equal(
    feedUrlForFilters({
      searchTerm: "rl hf",
      sources: ["80,000 Hours Podcast", "EA Forum"],
      tags: ["ai governance & policy"],
      novelty: 4,
    }),
    "https://aisafetyfeed.com/?q=rl%20hf&source=80%2C000%20Hours%20Podcast&source=EA%20Forum" +
      "&tag=ai%20governance%20%26%20policy&novelty=4"
  );
  assert.equal(feedUrlForFilters({ novelty: 1 }), "https://aisafetyfeed.com/");
});
