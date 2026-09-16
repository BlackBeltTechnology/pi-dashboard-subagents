// Which extension factories are slow to (re-)execute on a warm jiti cache?
import { createRequire } from "module"; const require = createRequire(import.meta.url);
import { DefaultResourceLoader, getAgentDir } from "/Users/robson/.nvm/versions/node/v25.8.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { loadExtensionsCached } from "/Users/robson/.nvm/versions/node/v25.8.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
const cwd = process.argv[2] ?? "/Users/robson/Project/judo-ng";
const parent = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() }); await parent.reload();
const paths = parent.getExtensions().extensions.map(e => e.path);
const rows = [];
for (let round = 0; round < 2; round++) for (const p of paths) {
  const a = performance.now(); await loadExtensionsCached([p], cwd, parent.eventBus); const ms = Math.round(performance.now() - a);
  if (round === 1) rows.push({ ms, p: p.replace(/^\/Users\/robson\//, "~/") });
}
rows.sort((a, b) => b.ms - a.ms);
require("fs").writeFileSync("/tmp/factory-cost.json", JSON.stringify({ total: rows.reduce((s, r) => s + r.ms, 0), top: rows.slice(0, 10) }, null, 1));
process.exit(0);
