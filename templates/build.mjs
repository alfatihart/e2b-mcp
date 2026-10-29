// Build template E2B. Butuh E2B_API_KEY di environment.
//   node templates/build.mjs v2     → template "node-postgres"
//   node templates/build.mjs v1     → template "docker-supabase"
//   node templates/build.mjs all
import { Template, defaultBuildLogger } from "e2b";
import { v1, v2 } from "./templates.mjs";

const targets = {
  v2: { template: v2, name: "node-postgres", cpuCount: 4, memoryMB: 4096 },
  v1: { template: v1, name: "docker-supabase", cpuCount: 4, memoryMB: 6144, minFreeDiskMb: 4096 },
};

const which = process.argv[2] ?? "all";
const selected = which === "all" ? Object.keys(targets) : [which];
if (!process.env.E2B_API_KEY) throw new Error("Isi E2B_API_KEY dulu.");

for (const key of selected) {
  const t = targets[key];
  if (!t) throw new Error(`Target tidak dikenal: ${key} (pakai v1, v2, atau all)`);
  console.log(`\n=== Build ${t.name} ===`);
  const { template, name, ...opts } = t;
  const info = await Template.build(template, name, { ...opts, onBuildLogs: defaultBuildLogger() });
  console.log(`Selesai: ${info.name} (templateId ${info.templateId})`);
}
