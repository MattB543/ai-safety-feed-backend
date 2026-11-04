// Route tests against a stubbed pool: no database is ever contacted.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { pool } = require("../src/db");
const app = require("../src/app");

let calls = [];
// Replace pool.query; respond(sql, params) returns the rows for each query.
function stubPool(respond = () => []) {
  calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: respond(sql, params) };
  };
}

test.afterEach(() => {
  calls = [];
});

test("/api/content caps limit at 100 and returns a bare array", async () => {
  stubPool(() => [{ id: 1 }]);
  const res = await request(app).get("/api/content?limit=100000&offset=50");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ id: 1 }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.slice(-2), [100, 50]);
  assert.match(calls[0].sql, /published_date DESC NULLS LAST, id DESC/);
});

test("/api/content maps the legacy params onto buildV1Where", async () => {
  stubPool();
  await request(app)
    .get("/api/content")
    .query({ sources: "EA Forum,Less Wrong", tags: "AI Safety", novelty_bucket: "4", order_by: "random" });
  const { sql, params } = calls[0];
  assert.deepEqual(params, [["EA Forum", "Less Wrong"], ["ai safety"], 71, 50, 0]);
  assert.match(sql, /novelty_score >= \$3/);
  assert.match(sql, /ORDER BY RANDOM\(\)/);
});

test("/api/content: novelty bucket 1 adds no floor (keeps unscored posts)", async () => {
  stubPool();
  await request(app).get("/api/content?novelty_bucket=1");
  assert.doesNotMatch(calls[0].sql, /novelty_score >=/);
});

test("/api/content rejects a non-integer limit", async () => {
  stubPool();
  const res = await request(app).get("/api/content?limit=lots");
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("/api/content/by-ids returns V1 columns for up to 100 ids", async () => {
  stubPool((_sql, [ids]) => ids.map((id) => ({ id })));
  const ids = Array.from({ length: 100 }, (_, i) => i + 1);
  const res = await request(app).get(`/api/content/by-ids?ids=${ids.join(",")}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 100);
  assert.match(calls[0].sql, /"image_prompt"/);
  assert.doesNotMatch(calls[0].sql, /full_content_markdown|embedding/);
});

test("/api/content/by-ids rejects more than 1000 ids", async () => {
  stubPool();
  const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
  const res = await request(app).get(`/api/content/by-ids?ids=${ids.join(",")}`);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("/api/content/by-ids: missing or junk ids are a 400", async () => {
  stubPool();
  assert.equal((await request(app).get("/api/content/by-ids")).status, 400);
  assert.equal((await request(app).get("/api/content/by-ids?ids=a,b")).status, 400);
  assert.equal(calls.length, 0);
});

test("/api/content/:id selects V1 columns and 404s when missing", async () => {
  stubPool(() => []);
  assert.equal((await request(app).get("/api/content/7")).status, 404);
  assert.doesNotMatch(calls[0].sql, /full_content_markdown|embedding/);
  assert.equal((await request(app).get("/api/content/abc")).status, 400);
});

test("/api/similar/:id returns a bare array of V1 posts", async () => {
  stubPool((sql) =>
    /embedding_short, embedding_full FROM content/.test(sql)
      ? [{ embedding_short: "[0.1]", embedding_full: "[0.2]" }]
      : [{ id: 2 }, { id: 3 }]
  );
  const res = await request(app).get("/api/similar/1");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ id: 2 }, { id: 3 }]);
  assert.equal(calls.length, 2);
  const { sql, params } = calls[1];
  assert.match(sql, /MIN\(dist\)/);
  assert.match(sql, /ORDER BY best\.dist/);
  assert.match(sql, /id <> \$3/);
  assert.doesNotMatch(sql.split("FROM best")[0].split("SELECT").pop(), /embedding/);
  assert.deepEqual(params, ["[0.1]", 20, 1, "[0.2]"]);
});

test("/api/similar/:id/ai is an alias for the same handler", async () => {
  stubPool((sql) =>
    /embedding_short, embedding_full FROM content/.test(sql)
      ? [{ embedding_short: "[0.1]", embedding_full: "[0.2]" }]
      : [{ id: 9 }]
  );
  const res = await request(app).get("/api/similar/1/ai");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ id: 9 }]);
});

test("/api/similar/:id 404s without the post or its embeddings, 400s on junk", async () => {
  stubPool(() => []);
  assert.equal((await request(app).get("/api/similar/5")).status, 404);
  assert.equal(calls.length, 1);
  assert.equal((await request(app).get("/api/similar/abc")).status, 400);
});

test("/api/source-stats filters through buildV1Where", async () => {
  stubPool(() => [{ source_type: "EA Forum", count: 3 }]);
  const res = await request(app).get(
    "/api/source-stats?search=x&tags=a&source_type=80,000%20Hours%20Podcast&novelty_min=41"
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ source_type: "EA Forum", count: 3 }]);
  assert.deepEqual(calls[0].params, ["%x%", ["80,000 Hours Podcast"], ["a"], 41]);
  assert.match(calls[0].sql, /GROUP BY source_type/);
});

test("/api/v1/posts returns data and pagination with hasMore", async () => {
  stubPool((sql) => (/COUNT\(\*\)/.test(sql) ? [{ total: 120 }] : [{ id: 1 }, { id: 2 }]));
  const res = await request(app).get("/api/v1/posts?limit=50&offset=0&sort=newest");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(res.body.pagination, { total: 120, limit: 50, offset: 0, hasMore: true });
  assert.match(calls.find((c) => !/COUNT/.test(c.sql)).sql, /"image_prompt"/);
});

test("/sitemap.xml lists the static pages and every /similar page", async () => {
  stubPool(() => [
    { id: 12, title: "Hello, World!", cleaned_title: null, lastmod: new Date("2026-10-01T05:00:00Z") },
  ]);
  const res = await request(app).get("/sitemap.xml");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/xml/);
  for (const p of ["/", "/about", "/digest", "/data"]) {
    assert.ok(res.text.includes(`<loc>https://aisafetyfeed.com${p}</loc>`), p);
  }
  assert.ok(
    res.text.includes(
      "<loc>https://aisafetyfeed.com/similar/hello-world-12</loc><lastmod>2026-10-01</lastmod>"
    )
  );
});

test("/api/subscribe accepts long TLDs and rejects junk", async () => {
  stubPool(() => [{ id: 1, email: "a@b.studio", frequency: "daily", is_active: true }]);
  const ok = await request(app).post("/api/subscribe").send({ email: "a+x@b.studio" });
  assert.equal(ok.status, 201);
  const bad = await request(app).post("/api/subscribe").send({ email: "not an email" });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 1);
});

test("Swagger lists every documented route", () => {
  const paths = Object.keys(app.swaggerSpec.paths);
  for (const p of ["/api/v1/posts", "/api/v1/posts/{id}", "/api/content/export", "/rss.xml"]) {
    assert.ok(paths.includes(p), p);
  }
  assert.ok(app.swaggerSpec.components.schemas.Post.properties.image_prompt);
});
