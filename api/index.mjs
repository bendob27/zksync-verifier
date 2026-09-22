// Serverless entry point.
//
// The API is already bundled to a single self-contained ESM file by esbuild, so this
// re-exports that app rather than asking the platform to trace a pnpm workspace.
// Static assets are served by the platform's CDN from the SPA build, not through here.
export { default } from '../artifacts/api-server/dist/app.mjs';
