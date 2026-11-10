const fs = require('fs');
const path = require('path');
const vm = require('vm');

// app/index.html is ~1,900 lines with a 1,400-line inline script and, until v1.6.2, no
// test coverage whatsoever. It ships as-is — there is no build step and no bundler to
// catch a typo — so a stray character takes the entire report page down and the only
// way anyone finds out is by opening it in Freshservice.
//
// These are cheap structural guards, not behavioural tests. They are not a substitute
// for looking at the page, but they catch the failures that are invisible in a diff.
const HTML = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');

function inlineScripts() {
  return [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

describe('report page (app/index.html)', () => {
  test('every inline script block parses', () => {
    const scripts = inlineScripts();
    expect(scripts.length).toBeGreaterThan(0);
    scripts.forEach((code, i) => {
      // Throws a SyntaxError with line info if the block is malformed.
      expect(() => new vm.Script(code, { filename: `index.html#script${i}` })).not.toThrow();
    });
  });

  // The table is built as a string in JS while the header is static markup, so the two
  // drift silently — a column added to one and not the other misaligns every row, and
  // the empty-state colspan has to match as well.
  test('header cells, body cells and colspan all agree', () => {
    const thead = HTML.match(/<thead>[\s\S]*?<\/thead>/)[0];
    const headerCells = (thead.match(/<th[\s>]/g) || []).length;

    const rowBuilder = HTML.match(/html \+= '<tr>';[\s\S]*?html \+= '<\/tr>';/)[0];
    const bodyCells = (rowBuilder.match(/html \+= '<td/g) || []).length;

    const colspans = [...HTML.matchAll(/colspan="(\d+)"/g)].map((m) => Number(m[1]));

    expect(bodyCells, 'body <td> count must match header <th> count').toBe(headerCells);
    for (const c of colspans) {
      expect(c, 'every colspan must span the full table width').toBe(headerCells);
    }
  });

  // Regression guard for 2026-08-27: a throttled read resolves looking exactly like an
  // empty shard, and the page asserted "No triage entries found" over the top of a fully
  // intact 1,657-entry dataset. `complete` had always been recorded and never read back.
  test('the empty state distinguishes "no data" from "could not read"', () => {
    expect(HTML).toMatch(/function rangeIncomplete\(\)/);
    // The guard must consider BOTH an incomplete shard scan and an unreadable day index —
    // when the bridge is throttled, triage_days fails too and the shard-0 heuristic loses
    // the only information that lets it tell empty from throttled.
    expect(HTML).toMatch(/rangeIncomplete\(\)\s*\|\|\s*!dayIndexReadOk/);
    expect(HTML).toMatch(/NOT "no data"/);
  });

  // Regression guard for the second half of the 2026-08-27 incident. A truncated
  // triage_days intersected a range containing today down to exactly ["today"] — a
  // NON-empty intersection, so the "fall back to the full range" escape hatch never
  // fired, and the reader scanned one day while 1,657 entries sat unread. The index must
  // never narrow the scan again; it survives only as a hint to the throttle heuristic.
  test('the day index never narrows which dates get scanned', () => {
    const loadData = HTML.match(/dbGetRetry\('triage_days'[\s\S]*?\.catch\(function \(\) \{/)[0];
    expect(loadData, 'must not filter the range down to the index intersection')
      .not.toMatch(/dates\.filter\([\s\S]*?activeDates\.indexOf/);
    expect(loadData, 'must not reintroduce the non-empty-intersection escape hatch')
      .not.toMatch(/toFetch\.length\s*\?/);
    expect(loadData, 'should scan the full requested range').toMatch(/return dates;/);
  });

  // v1.6.2 surfaced the `incomplete` flag; v1.6.4 stopped it crying wolf. The walker
  // probes one shard PAST the last populated one to learn a day has ended, and that probe
  // always fails — so `s > 0` marked every healthy multi-shard day incomplete, and the
  // warning fired on every successful load while showing the complete dataset. A warning
  // that is always on is worse than none.
  test('an end-of-day shard probe does not, by itself, mean "partial results"', () => {
    const walker = HTML.match(/function readDateSequential[\s\S]*?\n    \}/)[0];
    expect(walker, 'the bare s > 0 rule must not come back')
      .not.toMatch(/if \(s > 0 \|\| knownPopulated\) incomplete = true;/);
    // Only evidenced throttling, or a shard 0 the index promised, may set the flag.
    expect(walker).toMatch(/looksThrottledError\(err\)/);
    expect(walker).toMatch(/sawThrottle \|\| \(s === 0 && knownPopulated\)/);
  });

  describe('model / provider filter', () => {
    test('the control exists and starts unfiltered', () => {
      expect(HTML).toMatch(/<select[^>]*id="model-filter"/);
      expect(HTML).toMatch(/<option value="">All models<\/option>/);
    });

    test('the predicate is actually wired into applyFilters', () => {
      const applyFilters = HTML.match(/function applyFilters\(\)[\s\S]*?\n  \}/)[0];
      expect(applyFilters).toMatch(/modelFilter && !matchesModelFilter\(e\)/);
      // Stats must recompute from the FILTERED set — that is what makes this usable for
      // comparing per-provider cost rather than just hiding rows.
      expect(applyFilters).toMatch(/updateStats\(filtered\)/);
    });

    test('deflected entries are excluded from any provider narrowing', () => {
      const fn = HTML.match(/function matchesModelFilter\(e\)[\s\S]*?\n  \}/)[0];
      // A deflected ticket made no AI call, so it belongs to no provider. Letting $0 rows
      // fall into a vendor's bucket would understate that vendor's average cost.
      expect(fn).toMatch(/if \(e\.deflected\) return false;/);
    });

    test('options are rebuilt from loaded data, and a stale selection resets to All', () => {
      const fn = HTML.match(/function renderModelOptions\(\)[\s\S]*?\n  \}/)[0];
      expect(fn).toMatch(/allEntries/);
      // A filter pointing at a model absent from the current range would render an empty
      // table — indistinguishable from data loss, the exact mistake made twice already.
      expect(fn).toMatch(/if \(!stillValid\) modelFilter = ''/);
      expect(HTML).toMatch(/renderModelOptions\(\);\s*\n\s*applyFilters\(\);/);
    });

    test('pre-v1.6.0 entries bucket as "unknown" rather than vanishing', () => {
      expect(HTML).toMatch(/function entryProvider\(e\) \{ return e\.provider \|\| 'unknown'; \}/);
      expect(HTML).toMatch(/function entryModel\(e\) \{ return e\.model \|\| 'unknown'; \}/);
    });
  });

  test('destructive admin actions stay behind the admin-mode flag', () => {
    for (const id of ['wipe-btn', 'consolidate-btn', 'seed-btn']) {
      const btn = HTML.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
      expect(btn, `${id} should exist`).toBeTruthy();
      expect(btn[0], `${id} must be display:none until admin mode is enabled`).toMatch(/display\s*:\s*none/);
    }
  });
});
