// The daily/weekly email digest: HTML rendering, the per-subscriber query,
// batch sending through Postmark and the cron schedule.

const postmark = require("postmark");
const cron = require("node-cron");
const { pool } = require("./db");
const {
  selectCols,
  V1_SORTS,
  noveltyBucketMin,
  noveltyBucketOf,
  buildV1Where,
} = require("./params");
const {
  escapeHtml,
  safeHttpUrl,
  getDisplayTitle,
  generateSimilarUrl,
  FRONTEND_URL,
  API_BASE_URL,
} = require("./util");

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

// Helper to generate HTML (extracted from sendDigestEmail). total is the
// number of new posts, which can exceed the newContent shown.
function generateDigestHtml(subscription, newContent, total = newContent.length) {
  const unsubscribeUrl = `${API_BASE_URL}/api/unsubscribe/${subscription.unsubscribe_token}`;

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
      ? `<img src="${safeHttpUrl(imageUrl)}"
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
        `${escapeHtml(sourceTypeText)}&nbsp;&nbsp;|&nbsp;&nbsp;${escapeHtml(item.source_type)}`
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
      noveltyAndLinkParts.push(`Novelty Score: ${noveltyBucketOf(item.novelty_score)}/5`);
    }

    // Add similar post link
    const viewSimilarPostsUrl = generateSimilarUrl(item, FRONTEND_URL);
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
        <h3 style="margin-bottom: 5px; font-size: 1.3em;"><a href="${safeHttpUrl(
          item.source_url
        )}" style="color: #007bff; text-decoration: none;">${escapeHtml(
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

  const seeAllHtml =
    total > newContent.length
      ? `<p style="font-size: 1.1em; margin: 20px 0;"><a href="${escapeHtml(
          feedUrlForFilters(subscription.filters)
        )}" style="color: #007bff; text-decoration: none;">See all ${total} new posts &rarr;</a></p>`
      : "";

  return `
    <html>
      <body style="font-family: sans-serif; color: #333;">
        <div style="max-width: 650px; margin-left: 0; margin-right: auto;">
          <h2 style="font-size: 1.6em;">Your ${subscription.frequency} <a href="${FRONTEND_URL}/" style="text-decoration: underline;">AI Safety Feed</a> Digest</h2>
          ${statsHtml}
          ${itemsHtml}
          ${seeAllHtml}
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 0.9em; color: #888;">
            To unsubscribe from these updates, <a href="${unsubscribeUrl}" style="color: #007bff; text-decoration: none;">click here</a>.
          </p>
        </div>
      </body>
    </html>
  `;
}

// A digest lists at most this many posts; a "See all" link covers the rest.
const DIGEST_MAX_ITEMS = 20;
const DIGEST_FIELDS = [
  "id", "title", "source_url", "sentence_summary", "published_date", "cluster_tag",
  "topics", "novelty_score", "cleaned_title", "cleaned_image", "image_prompt",
  "source_type", "full_content_markdown",
];

// A subscriber's saved filters ({ searchTerm, sources, tags, novelty 1-5 })
// as buildV1Where query params, so the email filters exactly like the site.
function subscriptionQuery(filters) {
  const { searchTerm, sources, tags, novelty } = filters || {};
  const noveltyMin = Number.isInteger(novelty) ? noveltyBucketMin(novelty) : undefined;
  return {
    search: typeof searchTerm === "string" ? searchTerm : undefined,
    source_type: Array.isArray(sources) ? sources.map(String) : undefined,
    tags: Array.isArray(tags) ? tags.map(String) : undefined,
    novelty_min: noveltyMin === undefined ? undefined : String(noveltyMin),
  };
}

// The website's feed with the same filters, in its URL format:
// /?q=<search>&source=<name>&source=...&tag=<tag>&tag=...&novelty=<1-5>
function feedUrlForFilters(filters) {
  const { searchTerm, sources, tags, novelty } = filters || {};
  const p = new URLSearchParams();
  if (typeof searchTerm === "string" && searchTerm) p.append("q", searchTerm);
  if (Array.isArray(sources)) sources.forEach((s) => p.append("source", s));
  if (Array.isArray(tags)) tags.forEach((t) => p.append("tag", t));
  if (Number.isInteger(novelty) && novelty >= 2 && novelty <= 5) {
    p.append("novelty", String(novelty));
  }
  // %20 rather than +, which not every router decodes as a space.
  const qs = p.toString().replace(/\+/g, "%20");
  return `${FRONTEND_URL}/${qs ? `?${qs}` : ""}`;
}

// New posts for a subscription since its last digest: { rows, total }, where
// rows is the newest DIGEST_MAX_ITEMS and total counts all of them. Returns
// null on error.
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

  try {
    const { whereSQL, params } = buildV1Where(subscriptionQuery(subscription.filters));
    params.push(fetchSinceDate);
    const where = `${whereSQL ? `${whereSQL} AND` : "WHERE"} created_at > $${params.length}`;

    const { rows } = await pool.query(
      `SELECT ${selectCols(DIGEST_FIELDS)} FROM content ${where}
       ORDER BY ${V1_SORTS.newest}
       LIMIT ${DIGEST_MAX_ITEMS}`,
      params
    );
    // A short page is everything; only a full one needs counting.
    let total = rows.length;
    if (rows.length === DIGEST_MAX_ITEMS) {
      const {
        rows: [c],
      } = await pool.query(`SELECT COUNT(*)::int AS total FROM content ${where}`, params);
      total = c.total;
    }
    return { rows, total };
  } catch (err) {
    console.error(
      `[fetchContentForSubscription/${subscription.email}] Error querying content:`,
      err
    );
    return null; // Return null on error
  }
}

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
      const fetched = await fetchContentForSubscription(sub);

      if (fetched === null) {
        // Error occurred during fetch, skip this sub for now
        console.error(
          `[CronJob/DigestBatch] Skipping ${sub.email} due to content fetch error.`
        );
        continue;
      }
      const { rows: newContent, total } = fetched;

      if (newContent.length > 0) {
        // Create preheader text
        const preheaderStats = [];
        const sourceTypes = [
          ...new Set(newContent.map((c) => c.source_type)),
        ].filter(Boolean);
        preheaderStats.push(`${total} new posts`);
        if (sourceTypes.length > 0) {
          preheaderStats.push(`from ${sourceTypes.slice(0, 3).join(", ")}`);
        }
        const preheaderText = preheaderStats.join(" ");

        const htmlBody = generateDigestHtml(sub, newContent, total);

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
function startDigestCron() {
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
}

module.exports = {
  generateDigestHtml,
  subscriptionQuery,
  feedUrlForFilters,
  fetchContentForSubscription,
  processSubscriptionsAndSendBatches,
  startDigestCron,
};
