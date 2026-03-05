/**
 * Returns the application base URL for use in emails and shared links.
 * Uses APP_URL env var if set, otherwise defaults to the production custom domain.
 */
export function getBaseUrl(): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, "");
  }
  return "https://dashboard.wbrssystem.com";
}
