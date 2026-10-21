/**
 * Static DOM contract check.
 *
 * Every getElementById(...) used by the rescue frontend code must exist in
 * index.html, otherwise the panel fails silently in the browser. This is a
 * static check — it needs no server and no browser.
 *
 * Run: node test/dom-contract.js
 */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "index.html"),
  "utf8"
);

const sources = [
  "frontend/dashboard-rescue.js",
  "frontend/rescue-equipment.js",
  "frontend/rescue.js",
  "frontend/script.js",
  "frontend/sos-coordination.js",
];

let failures = 0;
let checked = 0;

for (const rel of sources) {
  const code = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const ids = new Set();

  // Direct calls plus the local aliases: `$()` (dashboard-rescue.js)
  // and `$sos()` (sos-coordination.js).
  const patterns = [
    /getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /(?<![A-Za-z0-9_$.])\$\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /(?<![A-Za-z0-9_$])\$sos\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(code)) !== null) {
      // Skip interpolated ids such as `page-${target}` — those are built at
      // runtime and cannot be checked against the static markup.
      if (!m[1].includes("${")) ids.add(m[1]);
    }
  }

  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  checked += ids.size;

  console.log(`\n${rel}: ${ids.size} static ids referenced`);
  if (missing.length === 0) {
    console.log("   ✅ all present in index.html");
  } else {
    failures += missing.length;
    console.log(`   ❌ missing: ${missing.join(", ")}`);
  }
}

// The dashboard emergency panel must be present and wired to its script.
const required = [
  'id="dashboard-emergency"',
  'id="dash-request-rescue"',
  'id="dash-view-incident"',
  'id="dash-emergency-status"',
  'src="dashboard-rescue.js"',
  'src="rescue.js"',
];
console.log("\nindex.html wiring:");
for (const frag of required) {
  if (html.includes(frag)) {
    console.log(`   ✅ ${frag}`);
  } else {
    failures += 1;
    console.log(`   ❌ ${frag}`);
  }
}

// Script load order matters: script.js defines the globals the others use.
const order = ["script.js", "dashboard-rescue.js", "rescue.js", "sos-coordination.js"].map((f) =>
  html.indexOf(`src="${f}"`)
);
if (
  order.every((i) => i >= 0) &&
  order[0] < order[1] &&
  order[1] < order[2] &&
  order[2] < order[3]
) {
  console.log(
    "   ✅ script load order is script.js → dashboard-rescue.js → rescue.js → sos-coordination.js"
  );
} else {
  failures += 1;
  console.log(`   ❌ bad script load order: ${JSON.stringify(order)}`);
}

console.log(`\n${failures === 0 ? "✅ DOM contract OK" : `❌ ${failures} problem(s)`} (${checked} ids checked)\n`);
process.exit(failures === 0 ? 0 : 1);
