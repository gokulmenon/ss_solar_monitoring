/**
 * Production CSV data is generated at build time and available as static
 * assets. Development keeps using the file-backed API so the dashboard can
 * reflect the relay's local archive without a rebuild.
 */
export function csvHistoryUrl(apiPath: string, snapshotPath: string) {
  return process.env.NODE_ENV === "production" ? snapshotPath : apiPath;
}
