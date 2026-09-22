export * from "./generated/api";
export * from "./generated/types";

// Both generated modules declare `OcrScreenshotsBody` and `VerifyTransactionsBody`:
// `generated/api` as a zod schema (a value), `generated/types` as a TypeScript type.
// Two `export *`s offering the same name is ambiguous, so re-export the schemas
// explicitly — an explicit export takes precedence over a star export.
export { OcrScreenshotsBody, VerifyTransactionsBody } from "./generated/api";
