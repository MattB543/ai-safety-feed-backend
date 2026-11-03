// Entry point (npm start). Loads .env, checks the database, schedules the
// email digest and starts the HTTP server. The app itself is in src/app.js.
require("dotenv").config();

const app = require("./src/app");
const { checkConnection } = require("./src/db");
const { startDigestCron } = require("./src/digest");

const PORT = process.env.PORT || 8000;

checkConnection();
startDigestCron();

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
