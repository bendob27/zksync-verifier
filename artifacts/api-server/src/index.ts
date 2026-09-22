import app from "./app";
import { logger } from "./lib/logger";
import { validateEnv } from "./lib/config";
import { isDemoMode } from "./lib/demo/mode";

try {
  validateEnv();
} catch (err) {
  logger.error((err as Error).message);
  process.exit(1);
}

const port = Number(process.env.PORT || 8080);

if (Number.isNaN(port) || port <= 0) {
  logger.error(`Invalid PORT value: "${process.env.PORT}"`);
  process.exit(1);
}

if (isDemoMode()) {
  logger.warn(
    "DEMO MODE: serving invented data, making no external calls, and publishing its own " +
      "login password. Never enable this on an instance holding real data.",
  );
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
