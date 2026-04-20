import { syncOsatData } from "../server/scraper/qualtrics-api";

async function main() {
  const raw = process.argv[2] ?? "90";
  const daysBack = Number(raw);
  if (!Number.isInteger(daysBack) || daysBack <= 0) {
    console.error(`Usage: tsx scripts/backfill-osat-speed.ts [daysBack]`);
    console.error(`  daysBack must be a positive integer (got "${raw}")`);
    process.exit(2);
  }
  console.log(`[Backfill] Re-running syncOsatData with daysBack=${daysBack} to populate DT/Generic Speed columns on daily_osat`);

  const start = Date.now();
  const result = await syncOsatData(daysBack);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`[Backfill] Done in ${elapsed}s. Synced ${result.synced} daily rows.`);
  if (result.errors.length) {
    console.log(`[Backfill] First errors (capped at 10):`);
    for (const err of result.errors) console.log(`  - ${err}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[Backfill] Failed:", err);
  process.exit(1);
});
