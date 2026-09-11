/**
 * Production CSV data is generated at build time and available as static
 * assets. Development keeps using the file-backed API so the dashboard can
 * reflect the relay's local archive without a rebuild.
 */
export function csvHistoryUrl(apiPath: string, snapshotPath: string) {
  if (process.env.NODE_ENV !== "production") return apiPath;

  // Static assets are immutable per deployment, but mobile Safari can retain a
  // disk-cached response across deployments. Version each page-load request so
  // the newest deployed archive snapshot is retrieved.
  return `${snapshotPath}${snapshotPath.includes("?") ? "&" : "?"}v=${Date.now()}`;
}
