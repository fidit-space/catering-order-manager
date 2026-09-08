/**
 * A test harness in 40 lines, with no dependencies.
 *
 * The project forbids npm and build steps (see CLAUDE_CODE_SPEC.md), so the
 * tests obey the same rule: `node test/run.js` and nothing else.
 */

function createSuite(name) {
  var results = { name: name, passed: 0, failed: 0, failures: [], lines: [] };
  var current = '';

  return {
    results: results,

    /** Groups the checks that follow under a heading. */
    section: function (title) {
      current = title;
      results.lines.push({ type: 'section', text: title });
    },

    /**
     * @param {string} label  what is being asserted, in plain words
     * @param {boolean} ok    the assertion
     * @param {string} [got]  the actual value, shown only on failure
     */
    check: function (label, ok, got) {
      if (ok) {
        results.passed++;
        results.lines.push({ type: 'pass', text: label });
      } else {
        results.failed++;
        results.failures.push({ section: current, label: label, got: got });
        results.lines.push({ type: 'fail', text: label, got: got });
      }
      return ok;
    },

    /** Asserts that a function throws. */
    throws: function (label, fn) {
      var threw = false;
      try { fn(); } catch (e) { threw = true; }
      return this.check(label, threw, 'did not throw');
    }
  };
}

module.exports = { createSuite: createSuite };
