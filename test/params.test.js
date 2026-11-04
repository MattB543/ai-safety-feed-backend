const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildV1Where,
  intParam,
  sortParam,
  dateParam,
  listParam,
  noveltyBucketMin,
  noveltyBucketOf,
  ValidationError,
  V1_POST_COLS,
  MAX_SEARCH_LENGTH,
} = require("../src/params");
const { csvCell } = require("../src/routes/content");

test("buildV1Where: no filters gives no WHERE", () => {
  assert.deepEqual(buildV1Where({}), { whereSQL: "", params: [] });
});

test("buildV1Where: source_type keeps commas in names", () => {
  const { whereSQL, params } = buildV1Where({ source_type: "80,000 Hours Podcast" });
  assert.match(whereSQL, /source_type = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(params, [["80,000 Hours Podcast"]]);
});

test("buildV1Where: repeated keys and the comma-split sources alias combine", () => {
  const { params } = buildV1Where({
    source_type: ["EA Forum", "80,000 Hours Podcast"],
    sources: "Less Wrong, AXRP",
  });
  assert.deepEqual(params, [["EA Forum", "80,000 Hours Podcast", "Less Wrong", "AXRP"]]);
});

test("buildV1Where: tags are lowercased, split on commas and repeatable", () => {
  const { whereSQL, params } = buildV1Where({ tags: ["AI Governance", "a,B"] });
  assert.match(whereSQL, /LOWER\(cluster_tag\) = ANY/);
  assert.deepEqual(params, [["ai governance", "a", "b"]]);
});

test("buildV1Where: numbers the placeholders in order", () => {
  const { whereSQL, params } = buildV1Where({
    search: "rlhf",
    tags: "x",
    novelty_min: "41",
    published_after: "2026-01-01",
  });
  assert.equal(params.length, 4);
  assert.deepEqual(params.slice(0, 3), ["%rlhf%", ["x"], 41]);
  for (let i = 1; i <= 4; i++) assert.ok(whereSQL.includes(`$${i}`));
  assert.ok(!whereSQL.includes("$5"));
});

test("buildV1Where: search is truncated to MAX_SEARCH_LENGTH", () => {
  const { params } = buildV1Where({ search: "a".repeat(500) });
  assert.equal(params[0], `%${"a".repeat(MAX_SEARCH_LENGTH)}%`);
});

test("buildV1Where: a repeated scalar param is a ValidationError", () => {
  assert.throws(() => buildV1Where({ search: ["a", "b"] }), ValidationError);
});

test("buildV1Where: bad numbers and dates are ValidationErrors", () => {
  assert.throws(() => buildV1Where({ novelty_min: "high" }), ValidationError);
  assert.throws(() => buildV1Where({ published_after: "yesterday" }), ValidationError);
  assert.throws(() => buildV1Where({ published_before: "2026-02-30" }), ValidationError);
});

test("dateParam accepts plain dates and timestamps", () => {
  assert.equal(dateParam({ d: "2026-01-31" }, "d"), "2026-01-31T00:00:00.000Z");
  assert.equal(dateParam({ d: "2026-01-31T12:00:00Z" }, "d"), "2026-01-31T12:00:00.000Z");
  assert.equal(dateParam({}, "d"), undefined);
});

test("intParam clamps, defaults and rejects non-integers", () => {
  assert.equal(intParam({}, "limit", 50, 1, 100), 50);
  assert.equal(intParam({ limit: "1000" }, "limit", 50, 1, 100), 100);
  assert.equal(intParam({ limit: "0" }, "limit", 50, 1, 100), 1);
  assert.throws(() => intParam({ limit: "-5" }, "limit", 50, 1, 100), ValidationError);
  assert.throws(() => intParam({ limit: "abc" }, "limit", 50, 1, 100), ValidationError);
});

test("sortParam: newest tie-breaks on id; unknown sorts are rejected", () => {
  assert.match(sortParam({}), /published_date DESC NULLS LAST, id DESC/);
  assert.equal(sortParam({ sort: "random" }), "RANDOM()");
  assert.throws(() => sortParam({ sort: "id; DROP TABLE content" }), ValidationError);
});

test("listParam ignores blanks", () => {
  assert.deepEqual(listParam({ ids: "1,,2, " }, "ids", { split: true }), ["1", "2"]);
  assert.deepEqual(listParam({}, "ids", { split: true }), []);
});

test("novelty buckets map to score floors and back", () => {
  assert.equal(noveltyBucketMin(1), undefined);
  assert.equal(noveltyBucketMin("2"), 21);
  assert.equal(noveltyBucketMin(5), 91);
  assert.equal(noveltyBucketMin("junk"), undefined);
  assert.equal(noveltyBucketOf(0), 1);
  assert.equal(noveltyBucketOf(20.5), 1);
  assert.equal(noveltyBucketOf(21), 2);
  assert.equal(noveltyBucketOf(70), 3);
  assert.equal(noveltyBucketOf(71), 4);
  assert.equal(noveltyBucketOf(100), 5);
});

test("V1 columns include image_prompt but never the body or vectors", () => {
  assert.match(V1_POST_COLS, /"image_prompt"/);
  assert.doesNotMatch(V1_POST_COLS, /full_content|embedding/);
});

test("csvCell quotes, encodes and neutralises formulas", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell(["a", "b"]), '"[""a"",""b""]"');
  assert.equal(csvCell(new Date("2026-01-01T00:00:00Z")), "2026-01-01T00:00:00.000Z");
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-1"), "'-1");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("\tx"), "'\tx");
  assert.equal(csvCell("\rx"), "\"'\rx\"");
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell(42.5), "42.5");
});
