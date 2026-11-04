// Email digest sign-up and unsubscribe.

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db");

const router = express.Router();

// --- Email Subscription Endpoints ---

// POST /api/subscribe
router.post("/api/subscribe", async (req, res) => {
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
router.get("/api/unsubscribe/:token", async (req, res) => {
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

module.exports = router;
