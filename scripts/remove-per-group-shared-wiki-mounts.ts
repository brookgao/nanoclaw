import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'store', 'messages.db');
const db = new Database(DB_PATH);

interface GroupRow {
  jid: string;
  folder: string;
  container_config: string | null;
}

const rows = db.prepare('SELECT jid, folder, container_config FROM registered_groups').all() as GroupRow[];
const update = db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?');

for (const row of rows) {
  if (!row.container_config) continue;
  const config = JSON.parse(row.container_config);
  if (!config.additionalMounts) continue;

  const before = config.additionalMounts.length;
  config.additionalMounts = config.additionalMounts.filter(
    (m: { containerPath?: string }) => m.containerPath !== 'shared-wiki'
  );
  const after = config.additionalMounts.length;

  if (before !== after) {
    if (config.additionalMounts.length === 0) delete config.additionalMounts;
    update.run(JSON.stringify(config), row.jid);
    console.log(`${row.folder}: removed shared-wiki mount (${before} -> ${after})`);
  }
}

db.close();
console.log('Done.');
