const { auditVersions } = require('../sync-version');

// The report page footer sat at v1.5.0 through two releases because it was a
// hand-maintained string with nothing checking it. CLAUDE.md's "a version bump touches
// N places" rule is only as good as someone's memory, so this makes drift fail the
// suite instead — and `fdk pack` runs the suite.
//
// Fix any failure here with:  node sync-version.js
describe('version consistency', () => {
  const { version, results } = auditVersions();

  test('package.json carries a plain semver version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const r of results) {
    test(`${r.file} matches package.json (${r.label})`, () => {
      if (r.missing) {
        throw new Error(
          `No version marker found in ${r.file} — ${r.label}. ` +
          `Either it was edited out, or sync-version.js's pattern needs updating.`
        );
      }
      expect(
        r.found,
        `${r.file} says ${r.found} but package.json says ${version}. Run: node sync-version.js`
      ).toBe(version);
    });
  }
});
