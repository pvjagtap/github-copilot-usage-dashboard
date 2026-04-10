#!/usr/bin/env node
/**
 * apply-repo-config.js
 *
 * Reads repo.config.json and patches all repo-specific references in:
 *   - package.json  (publisher, repository, homepage, bugs)
 *   - README.md     (marketplace link)
 *   - LICENSE        (copyright holder)
 *
 * Usage:
 *   node apply-repo-config.js              # uses repo.config.json in cwd
 *   node apply-repo-config.js path/to/repo.config.json
 */

const fs = require("fs");
const path = require("path");

const configPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "repo.config.json");

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const root = path.dirname(configPath);

const ghUrl = `https://github.com/${cfg.owner}/${cfg.repo}`;

// --- package.json ---
const pkgPath = path.join(root, "package.json");
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.publisher = cfg.publisher;
  pkg.repository = { type: "git", url: ghUrl };
  pkg.homepage = `${ghUrl}#readme`;
  pkg.bugs = { url: `${ghUrl}/issues` };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log("✓ package.json updated");
}

// --- README.md ---
const readmePath = path.join(root, "README.md");
if (fs.existsSync(readmePath)) {
  let readme = fs.readFileSync(readmePath, "utf8");
  // Replace marketplace link publisher.extension pattern
  readme = readme.replace(
    /marketplace\.visualstudio\.com\/items\?itemName=[^)"\s]+/g,
    `marketplace.visualstudio.com/items?itemName=${cfg.publisher}.${cfg.extensionName}`
  );
  // Replace any GitHub repo URLs (owner/repo pattern)
  readme = readme.replace(
    /https:\/\/github\.com\/[^/\s)]+\/github-copilot-usage-dashboard/g,
    ghUrl
  );
  fs.writeFileSync(readmePath, readme);
  console.log("✓ README.md updated");
}

// --- LICENSE ---
const licPath = path.join(root, "LICENSE");
if (fs.existsSync(licPath)) {
  let lic = fs.readFileSync(licPath, "utf8");
  // Replace "Copyright (c) YYYY <holder>" line
  lic = lic.replace(
    /Copyright\s+\(c\)\s+\d{4}\s+\S+/,
    `Copyright (c) ${new Date().getFullYear()} ${cfg.copyrightHolder}`
  );
  fs.writeFileSync(licPath, lic);
  console.log("✓ LICENSE updated");
}

console.log(`\nAll files updated for ${cfg.owner}/${cfg.repo}`);
