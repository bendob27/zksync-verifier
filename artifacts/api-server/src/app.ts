import { existsSync } from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

if (!process.env.CORS_ORIGIN) {
  logger.warn('CORS_ORIGIN is not set — CORS is permissive (allows all origins). Set CORS_ORIGIN to lock to a specific domain in production.');
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the built dashboard from this same process when it is present, so the whole tool
// is one deployable service. In development Vite serves it instead and this is skipped.
const staticDir = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(process.cwd(), "artifacts/zksync-unlock-parser/dist/public");

if (existsSync(path.join(staticDir, "index.html"))) {
  logger.info({ staticDir }, "Serving the dashboard from this process");
  app.use(express.static(staticDir, { index: false }));
  // SPA fallback: anything that is not an API route or a real file is the app itself.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
} else {
  logger.info({ staticDir }, "No dashboard build found; serving the API only");
}

export default app;
