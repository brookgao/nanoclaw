import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.resolve(process.cwd(), "store/messages.db");

const THRESHOLDS: Record<string, number> = {
  feishu_main: 80000,
  feishu_dm: 80000,
  "feishu_pm-doc-quality": 50000,
  "feishu_pm-openspec-quality": 50000,
  "feishu_langgraph-pm": 50000,
};

const DEFAULT_THRESHOLD = 60000;

function main() {
  const db = new Database(DB_PATH);

  const rows = db
    .prepare("SELECT folder, container_config FROM registered_groups")
    .all() as Array<{ folder: string; container_config: string | null }>;

  const update = db.prepare(
    "UPDATE registered_groups SET container_config = ? WHERE folder = ?"
  );

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const config = row.container_config
      ? JSON.parse(row.container_config)
      : {};

    if ("autoCompactWindow" in config) {
      console.log(
        `SKIP  ${row.folder}: already has autoCompactWindow=${config.autoCompactWindow}`
      );
      skipped++;
      continue;
    }

    const threshold =
      THRESHOLDS[row.folder] !== undefined
        ? THRESHOLDS[row.folder]
        : DEFAULT_THRESHOLD;

    config.autoCompactWindow = threshold;
    update.run(JSON.stringify(config), row.folder);
    console.log(`SET   ${row.folder}: autoCompactWindow=${threshold}`);
    updated++;
  }

  db.close();
  console.log(`\nDone: ${updated} updated, ${skipped} skipped.`);
}

main();
