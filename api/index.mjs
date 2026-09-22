// Serverless entry point.
//
// The API is already bundled to a single self-contained ESM file by esbuild, so this
// re-exports that app rather than asking the platform to trace a pnpm workspace.
// Static assets are served by the platform's CDN from the SPA build, not through here.
//
// Boot validation lives in the long-running entry (index.ts), which a serverless platform
// never loads — so it is run here too. Throwing at module load fails the function loudly,
// which is what we want: a misconfigured instance must not answer requests at all.
import { validateEnv } from '../artifacts/api-server/dist/lib/config.mjs';
import app from '../artifacts/api-server/dist/app.mjs';

validateEnv();

export default app;
