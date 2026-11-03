// Small helpers shared by the routes and the email digest.

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

// Helper function to generate similar page URL
function generateSimilarUrl(article, baseUrl) {
  const displayTitle = getDisplayTitle(article);
  const slug = slugify(displayTitle);
  return `${baseUrl}/similar/${slug}-${article.id}`;
}

// The website (Netlify) and this API (Render) live on different hosts.
// FRONTEND_URL is for links to site pages (/similar/..., the feed);
// API_BASE_URL is this API's public URL, for links back to it (unsubscribe).
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://aisafetyfeed.com").replace(/\/$/, "");
const API_BASE_URL = (
  process.env.API_BASE_URL ||
  process.env.BASE_URL ||
  `http://localhost:${process.env.PORT || "8000"}`
).replace(/\/$/, "");

module.exports = {
  escapeHtml,
  getDisplayTitle,
  slugify,
  generateSimilarUrl,
  FRONTEND_URL,
  API_BASE_URL,
};
