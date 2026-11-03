// The Express app: middleware, Swagger and the route modules. server.js
// starts it; tests import it directly with a stubbed pool.

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const { FRONTEND_URL } = require("./util");

const app = express();

// Render terminates TLS and proxies to us. Trust that one hop so req.ip, and
// therefore the per-IP rate limit, refers to the client rather than the proxy.
app.set("trust proxy", 1);

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
        url: FRONTEND_URL,
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
  // Files with @swagger JSDoc blocks. Absolute, so it doesn't depend on the
  // working directory; forward slashes, because glob needs them on Windows.
  apis: [path.join(__dirname, "routes", "*.js").replace(/\\/g, "/")],
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

app.use(require("./routes/content"));
app.use(require("./routes/similar"));
app.use(require("./routes/v1"));
app.use(require("./routes/feeds"));
app.use(require("./routes/subscribe"));

module.exports = app;
module.exports.swaggerSpec = swaggerSpec;
