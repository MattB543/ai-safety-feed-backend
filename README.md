# AI Safety Feed backend

The API behind [aisafetyfeed.com](https://aisafetyfeed.com): an Express 5 server on Render that reads the curated posts in Postgres (`public.content`, with pgvector embeddings) and sends the daily/weekly email digests through Postmark. The posts themselves are scraped, summarised and embedded by the separate scraping pipeline (`ai-safety-feed-helpers`).

## Running

```sh
npm install
npm start        # node server.js, on $PORT (default 8000)
npm run dev      # the same under nodemon
npm test         # node:test + supertest; uses a stubbed pool, never a database
```

`npm start` reads `.env`, checks the database connection, schedules the digest cron job (08:00 America/New_York; every minute when `NODE_ENV=development`, so don't use that against the production database) and listens.

## Environment variables

See `.env.example`.

| Name | Purpose |
| --- | --- |
| `PG_URL` | Postgres connection string. |
| `POSTMARK_API_KEY` | Postmark server token. Without it the digest job logs a warning and sends nothing. |
| `NODE_ENV` | `development` runs the digest job every minute. |
| `PORT` | HTTP port (Render sets it). |
| `FRONTEND_URL` | The website, for `/similar/...` and feed links in emails, RSS and the sitemap. Default `https://aisafetyfeed.com`. |
| `API_BASE_URL` | This API's public URL, for the unsubscribe link, the Swagger server and the RSS self link. Falls back to `BASE_URL`, then `http://localhost:$PORT` (Swagger and RSS fall back to `BACKEND_URL`, then the request host). |

## Endpoints

The public API is documented in Swagger at `/api-docs`.

- `GET /api/v1/posts` (filters, `sort`, `limit`/`offset`, `{data, pagination}`), `/api/v1/posts/:id`, `/api/v1/posts/by-uuid/:uuid`, and `/api/v1/posts/{sources,tags,topics,stats}`.
- `GET /api/content/export`: the dataset as CSV, with the same filters.
- `GET /rss.xml` (also `/feed.xml`): RSS, with the same filters.
- `GET /sitemap.xml`: the site's pages and every post's `/similar` page. Netlify proxies `aisafetyfeed.com/sitemap.xml` here.

Used by the website:

- `GET /api/similar/:id`: up to 20 posts nearest by embedding. `/api/similar/:id/ai` is a deprecated alias.
- `GET /api/content/by-ids?ids=1,2,3` (bookmarks, at most 100), `GET /api/content/:id`.
- `GET /api/source-stats`, `GET /api/tags`, `GET /api/sources`: filter counts.
- `POST /api/subscribe`, `GET /api/unsubscribe/:token`: the email digest.
- `GET /api/content`: the old feed endpoint, kept as a deprecated adapter until the new frontend is live. Delete it after that.

Every list endpoint filters through `buildV1Where` in `src/params.js`, so the site, API, CSV, RSS and emails agree.

## Layout

- `server.js`: entry point.
- `src/app.js`: middleware, Swagger and the routers. Tests import it directly.
- `src/db.js`: the pool.
- `src/params.js`: query parsing, `buildV1Where`, the column lists.
- `src/routes/`: `content`, `v1`, `similar`, `feeds` (RSS, sitemap), `subscribe`.
- `src/digest.js`: digest HTML, query, sending and cron.

## Deploying

Render runs `npm start`; no build step. When an API change and a frontend change go together, deploy the backend first, then the frontend (Netlify), so the live site never calls an endpoint that doesn't exist yet.
