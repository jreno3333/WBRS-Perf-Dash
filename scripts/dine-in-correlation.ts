import { posPool } from "../server/db";

async function main() {
  const sql = `
    WITH src AS (
      SELECT
        store_number,
        CASE
          WHEN LOWER(order_source) IN ('app','mobile','online','web') THEN 'app'
          WHEN LOWER(order_source) LIKE '%3pd%' OR LOWER(order_source) IN ('doordash','ubereats','grubhub')
            OR LOWER(order_source) LIKE '%door dash%' OR LOWER(order_source) LIKE '%uber eat%' OR LOWER(order_source) LIKE '%grub%'
            OR LOWER(order_source) LIKE '%delivery%' THEN '3pd'
          WHEN LOWER(order_source) IN ('in','dine-in','kiosk','cat','pho') OR LOWER(order_source) LIKE '%dine%' THEN 'dine_in'
          WHEN LOWER(order_source) IN ('dt3','out') THEN 'dt3_outside'
          WHEN LOWER(order_source) IN ('dt1','dt2','drive-thru','drive_thru') THEN 'drive_thru'
          WHEN LOWER(order_source) = 'pos' THEN 'pos'
          ELSE 'other'
        END AS ch,
        order_total
      FROM pos_orders
      WHERE business_date >= CURRENT_DATE - INTERVAL '30 days'
    ),
    agg AS (
      SELECT store_number,
        SUM(CASE WHEN ch IN ('drive_thru','dt3_outside') THEN 1 ELSE 0 END) AS true_dt,
        SUM(CASE WHEN ch='pos' THEN 1 ELSE 0 END) AS pos_cnt,
        SUM(CASE WHEN ch='dine_in' THEN 1 ELSE 0 END) AS di_cnt,
        COUNT(*) AS total_cnt,
        SUM(order_total)::numeric AS total_sales
      FROM src GROUP BY store_number
    )
    SELECT store_number, total_sales,
      CASE WHEN true_dt > 0 THEN di_cnt::float/total_cnt ELSE (di_cnt+pos_cnt)::float/total_cnt END AS di_pct,
      CASE WHEN true_dt > 0 THEN 1 ELSE 0 END AS has_dt
    FROM agg WHERE total_cnt >= 100
    ORDER BY total_sales DESC;
  `;
  const r = await posPool.query(sql);
  const rows = r.rows.map((x: any) => ({
    store: x.store_number,
    sales: Number(x.total_sales),
    di: Number(x.di_pct) * 100,
    dt: x.has_dt === 1,
  }));

  function corr(xs: number[], ys: number[]) {
    const n = xs.length; if (n < 2) return NaN;
    const mx = xs.reduce((a,b)=>a+b,0)/n;
    const my = ys.reduce((a,b)=>a+b,0)/n;
    let num=0, dx=0, dy=0;
    for (let i=0;i<n;i++){ const a=xs[i]-mx, b=ys[i]-my; num+=a*b; dx+=a*a; dy+=b*b; }
    return num / Math.sqrt(dx*dy);
  }

  const all = rows;
  const dt = rows.filter(r=>r.dt);
  const non = rows.filter(r=>!r.dt);

  console.log(`Units: total=${all.length}  DT=${dt.length}  non-DT=${non.length}`);
  console.log(`Corr(dine-in %, 30d sales) ALL       : ${corr(all.map(r=>r.di), all.map(r=>r.sales)).toFixed(3)}`);
  console.log(`Corr(dine-in %, 30d sales) DT only   : ${corr(dt.map(r=>r.di), dt.map(r=>r.sales)).toFixed(3)}`);
  console.log(`Corr(dine-in %, 30d sales) non-DT    : ${corr(non.map(r=>r.di), non.map(r=>r.sales)).toFixed(3)}`);

  function bucket(rs: typeof rows) {
    const buckets = [[0,10],[10,20],[20,30],[30,40],[40,100]];
    for (const [lo,hi] of buckets) {
      const b = rs.filter(r=>r.di>=lo && r.di<hi);
      if (b.length===0) continue;
      const avg = b.reduce((a,r)=>a+r.sales,0)/b.length;
      console.log(`  di ${String(lo).padStart(2)}–${String(hi).padStart(3)}%  n=${String(b.length).padStart(3)}  avg 30d sales = $${Math.round(avg).toLocaleString()}`);
    }
  }
  console.log("\nDT-equipped units, sales by dine-in % bucket:");
  bucket(dt);
  console.log("\nNon-DT units, sales by dine-in % bucket:");
  bucket(non);

  await posPool.end();
}
main().catch(e=>{ console.error(e); process.exit(1); });
