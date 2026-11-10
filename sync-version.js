/**
 * Version sync + audit for AI-Triage.
 *
 * `package.json` is the single source of truth. Every other place the version appears is
 * declared below, so adding a new one means adding an entry here — not remembering a
 * step in a checklist.
 *
 * Why this exists: the report page's footer sat at v1.5.0 through two releases because
 * it was a hand-maintained string with no check behind it. `config/iparams.json` had the
 * same shape of problem and only stayed correct because CLAUDE.md nagged about it.
 * A policy that relies on remembering is a policy that drifts.
 *
 *   node sync-version.js          rewrite every site to match package.json
 *   node sync-version.js --check  report drift and exit non-zero, changing nothing
 *
 * `tests/version.test.js` calls auditVersions() so drift fails the unit suite — which
 * `fdk pack` runs — rather than shipping quietly.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SEMVER = String.raw`\d+\.\d+\.\d+`;

// Each site: where the version lives, how to find it, and how to write it back.
// `find` must capture the version itself in group 1.
const VERSION_SITES = [
  {
    file: 'config/iparams.json',
    label: 'install-page version label (freshservice_domain description)',
    find: new RegExp(`AI-Triage v(${SEMVER})`),
    make: (v) => `AI-Triage v${v}`,
  },
  {
    file: 'app/index.html',
    label: 'report page footer',
    find: new RegExp(`<span id="app-version">(${SEMVER})</span>`),
    make: (v) => `<span id="app-version">${v}</span>`,
  },
];

function currentVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

// Returns [{ file, label, found, expected, ok, missing }] plus the CHANGELOG check.
// Pure read — safe to call from tests.
function auditVersions() {
  const version = currentVersion();
  const results = VERSION_SITES.map((site) => {
    const text = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
    const m = text.match(site.find);
    return {
      file: site.file,
      label: site.label,
      expected: version,
      found: m ? m[1] : null,
      missing: !m,
      ok: !!m && m[1] === version,
    };
  });

  // The CHANGELOG is verified, never rewritten — an entry is prose that has to be
  // written by hand, and silently inventing a heading would defeat the point.
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const hasEntry = new RegExp(`^## ${version.replace(/\./g, '\\.')} `, 'm').test(changelog);
  results.push({
    file: 'CHANGELOG.md',
    label: `dated entry for ${version}`,
    expected: version,
    found: hasEntry ? version : null,
    missing: !hasEntry,
    ok: hasEntry,
  });

  return { version, results };
}

function sync() {
  const version = currentVersion();
  let changed = 0;
  for (const site of VERSION_SITES) {
    const full = path.join(ROOT, site.file);
    const text = fs.readFileSync(full, 'utf8');
    const m = text.match(site.find);
    if (!m) {
      console.error(`  !! ${site.file}: version marker NOT FOUND — ${site.label}`);
      console.error(`     Expected something matching: ${site.find}`);
      continue;
    }
    if (m[1] === version) {
      console.log(`  ok ${site.file} (already ${version})`);
      continue;
    }
    fs.writeFileSync(full, text.replace(site.find, site.make(version)));
    console.log(`  -> ${site.file}: ${m[1]} => ${version}`);
    changed++;
  }
  return { version, changed };
}

function report(audit) {
  console.log(`package.json version: ${audit.version}\n`);
  for (const r of audit.results) {
    const status = r.ok ? 'ok  ' : (r.missing ? 'MISS' : 'DRIFT');
    console.log(`  ${status} ${r.file} — ${r.label}${r.ok ? '' : ` (found: ${r.found ?? 'none'})`}`);
  }
  return audit.results.every((r) => r.ok);
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  if (check) {
    process.exit(report(auditVersions()) ? 0 : 1);
  }
  console.log(`Syncing version references to package.json...`);
  const { version, changed } = sync();
  console.log(`\n${changed} file(s) updated to ${version}.`);
  const ok = report(auditVersions());
  if (!ok) console.log(`\nOne or more sites still need attention (a missing CHANGELOG entry must be written by hand).`);
  process.exit(ok ? 0 : 1);
}

module.exports = { auditVersions, currentVersion, VERSION_SITES };
