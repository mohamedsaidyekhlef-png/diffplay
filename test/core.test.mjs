import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildWalkthrough, parseDiff, renderHtml, renderMarkdown } from "../dist/index.js";

// The fixture holds a placeholder instead of a key-shaped string so GitHub push
// protection doesn't block the repo; the realistic fake is assembled here.
const FAKE_KEY = ["sk", "live", "51NqAbCdEfGhIjKlMnOpQrStUv"].join("_");
export const fixture = readFileSync(new URL("./fixtures/agent-pr.diff", import.meta.url), "utf8")
  .replaceAll("__FAKE_STRIPE_LIVE_KEY__", FAKE_KEY);

test("parses files, counts and statuses", () => {
  const files = parseDiff(fixture);
  assert.equal(files.length, 11);
  const seats = files.find((f) => f.path === "src/lib/seats.ts");
  assert.equal(seats.status, "added");
  const total = files.reduce((n, f) => n + f.additions, 0);
  assert.equal(total, 148);
});

test("a deleted SQL comment line is not mistaken for a file header", () => {
  const diff = [
    "diff --git a/q.sql b/q.sql",
    "--- a/q.sql",
    "+++ b/q.sql",
    "@@ -1,3 +1,2 @@",
    "-- keep",
    "--- a comment that starts with dashes",
    "+select 1;",
    " select 2;",
    "",
  ].join("\n");
  const [f] = parseDiff(diff);
  assert.equal(f.path, "q.sql");
  assert.equal(f.deletions, 2);
  assert.equal(f.additions, 1);
});

test("renames, binaries and missing newline markers", () => {
  const diff = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 100%",
    "rename from old.ts",
    "rename to new.ts",
    "diff --git a/logo.png b/logo.png",
    "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/x.txt b/x.txt",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1 +1 @@",
    "-a",
    "\\ No newline at end of file",
    "+b",
    "\\ No newline at end of file",
  ].join("\n");
  const files = parseDiff(diff);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [["new.ts", "renamed"], ["logo.png", "modified"], ["x.txt", "modified"]]);
  assert.equal(files[1].binary, true);
  assert.equal(files[2].additions, 1);
});

test("story order puts the data model first and tests late", () => {
  const w = buildWalkthrough(fixture);
  const layers = w.steps.map((s) => s.layer);
  assert.equal(layers[0], "schema");
  assert.ok(layers.indexOf("core") < layers.indexOf("tests"));
  assert.equal(w.hiddenFiles.length, 1, "lock file is hidden");
});

test("catches the classic agent mistakes", () => {
  const w = buildWalkthrough(fixture);
  const labels = new Set(w.topRisks.map((r) => r.hit.rule));
  for (const rule of ["drop", "mass-delete", "auth-removed", "sql-concat", "secret", "xss", "swallow", "test-disabled"]) {
    assert.ok(labels.has(rule), `expected ${rule}`);
  }
});

test("quiet on ordinary code", () => {
  const diff = [
    "diff --git a/src/math.ts b/src/math.ts",
    "--- a/src/math.ts",
    "+++ b/src/math.ts",
    "@@ -1,3 +1,4 @@",
    " export function add(a: number, b: number) {",
    "-  return a+b;",
    "+  const sum = a + b;",
    "+  return sum;",
    " }",
    "diff --git a/tests/auth.test.ts b/tests/auth.test.ts",
    "--- a/tests/auth.test.ts",
    "+++ b/tests/auth.test.ts",
    "@@ -1 +1,2 @@",
    " import { sign } from '../src/jwt';",
    "+const token = sign({ id: 1 }, { secret: 'a-secret-for-tests' });",
    "",
  ].join("\n");
  const w = buildWalkthrough(diff);
  assert.equal(w.stats.risks.high, 0);
  assert.equal(w.stats.risks.medium, 0);
});

test("renders HTML and Markdown that escape code", () => {
  const w = buildWalkthrough(fixture, { title: "<script>alert(1)</script>" });
  const html = renderHtml(w);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('class="strip"'));
  const md = renderMarkdown(w, "https://example.com/w");
  assert.ok(md.startsWith("<!-- diffplay -->"));
  assert.ok(md.includes("Read these first"));
});

test("a package's own version bump is not a new dependency", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,3 +1,3 @@",
    " {",
    '-  "version": "4.13.13",',
    '+  "version": "4.13.14",',
    "",
  ].join("\n");
  assert.equal(buildWalkthrough(diff).stats.risks.medium, 0);
});

test("a test file moved to a new folder is not a deleted test", () => {
  const diff = [
    "diff --git a/runtime-tests/ssg.test.tsx b/runtime-tests/ssg.test.tsx",
    "deleted file mode 100644",
    "--- a/runtime-tests/ssg.test.tsx",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-it('renders', () => {})",
    "diff --git a/adapters/deno/test/ssg.test.ts b/adapters/deno/test/ssg.test.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/adapters/deno/test/ssg.test.ts",
    "@@ -0,0 +1 @@",
    "+it('renders', () => {})",
    "",
  ].join("\n");
  assert.equal(buildWalkthrough(diff).stats.risks.high, 0);
});

test("non-ASCII and spaced file names are decoded", () => {
  const diff = [
    'diff --git "a/src/\\303\\274n\\303\\257code/na\\303\\257ve.py" "b/src/\\303\\274n\\303\\257code/na\\303\\257ve.py"',
    'index 1..2 100644',
    '--- "a/src/\\303\\274n\\303\\257code/na\\303\\257ve.py"',
    '+++ "b/src/\\303\\274n\\303\\257code/na\\303\\257ve.py"',
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/src/my folder/file name.ts b/src/my folder/file name.ts",
    "--- a/src/my folder/file name.ts",
    "+++ b/src/my folder/file name.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  assert.deepEqual(parseDiff(diff).map((f) => f.path), ["src/ünïcode/naïve.py", "src/my folder/file name.ts"]);
});

test("assertions moved between test files are not a loss; a real loss is one file-level flag", () => {
  const mk = (path, lines) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${lines.filter((l) => l[0] !== "+").length} +1,${lines.filter((l) => l[0] !== "-").length} @@`, ...lines].join("\n");
  const moved = [
    mk("tests/a.test.ts", ["-expect(a).toBe(1)", "-expect(b).toBe(2)", " // end"]),
    mk("tests/b.test.ts", ["+expect(a).toBe(1)", "+expect(b).toBe(2)", " // end"]),
  ].join("\n") + "\n";
  assert.equal(buildWalkthrough(moved).stats.risks.medium, 0);
  const lost = mk("tests/a.test.ts", ["-expect(a).toBe(1)", "-expect(b).toBe(2)", "-expect(c).toBe(3)", " // end"]) + "\n";
  const w = buildWalkthrough(lost);
  assert.equal(w.stats.risks.medium, 1);
  assert.match(w.topRisks[0].hit.label, /Fewer assertions/);
});

test("conditional test skips are not flagged", () => {
  const diff = ["diff --git a/tests/t.py b/tests/t.py", "--- a/tests/t.py", "+++ b/tests/t.py", "@@ -1 +1,2 @@", "+@pytest.mark.skipif(sys.version_info < (3, 10), reason='needs 3.10')", " def test_x(): pass", ""].join("\n");
  assert.equal(buildWalkthrough(diff).stats.risks.medium, 0);
});
