import { syncEmployees } from "../server/scraper/7shifts-api";
import { syncTrainingPlatform } from "../server/scraper/training-api";
import { db } from "../server/db";
import { employees } from "../shared/schema";
import { sql } from "drizzle-orm";

(async () => {
  console.log("=== 1. Syncing 7shifts employees (to populate punch_id) ===");
  const er = await syncEmployees();
  console.log("employee sync:", er);

  const punchCount = await db.execute(sql`SELECT COUNT(*) AS n, COUNT(punch_id) AS with_punch FROM employees`);
  console.log("employees row count + with-punch:", punchCount.rows);

  console.log("\n=== 2. Syncing LMS training-completions ===");
  const tr = await syncTrainingPlatform();
  console.log("training sync result:", JSON.stringify(tr, null, 2).slice(0, 2000));

  console.log("\n=== 3. Sample synced rows ===");
  const sample = await db.execute(sql`
    SELECT e.first_name||' '||e.last_name AS name, e.punch_id,
           p.external_course_id, p.percent_complete, p.status
    FROM training_employee_progress p
    JOIN employees e ON e.id = p.employee_id
    WHERE p.external_course_id = '_overall'
    ORDER BY p.percent_complete::numeric DESC LIMIT 10
  `);
  console.table(sample.rows);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
