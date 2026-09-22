import app from "./app";
import { logger } from "./lib/logger";
import { validateEnv } from "./lib/config";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
