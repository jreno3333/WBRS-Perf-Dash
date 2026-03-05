/**
 * Returns the application base URL for use in emails and shared links.
 * Priority: APP_URL env var > REPL_SLUG > REPLIT_DEV_DOMAIN > default production domain
 */
export function getBaseUrl(): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/+$/, "");
  }
  if (process.env.REPL_SLUG) {
    return `https://${process.env.REPL_SLUG}.replit.app`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return "https://wbrssystem.com";
}
