import type { DiffLine, FileDiff, RiskHit, Severity } from "./types.js";

export const SEVERITY_SCORE: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

interface LineRule {
  id: string;
  label: string;
  severity: Severity;
  why: string;
  /** Which side of the diff the rule looks at. */
  on: "add" | "del" | "both";
  re: RegExp;
  /** Skip the rule for files whose path matches. */
  skipPath?: RegExp;
}

const TEST_OR_DOC = /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|docs?)\/|\.(test|spec)\.\w+$|\.(md|mdx|rst|txt)$/i;

const LINE_RULES: LineRule[] = [
  // ── Secrets ─────────────────────────────────────────────
  { id: "secret", label: "Possible secret", severity: "high", on: "add",
    why: "Looks like a real credential committed to the repo. Rotate it if it is live.",
    re: /(AKIA[0-9A-Z]{16}|sk-(proj-|ant-)?[A-Za-z0-9_-]{20,}|(sk|rk)_live_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35})/,
    skipPath: /\.(md|mdx)$/i },
  { id: "secret-assign", label: "Hardcoded credential", severity: "high", on: "add",
    why: "A key, password or token is written into the code. Move it to an environment variable.",
    // Generic key = "value" pairs; obvious placeholders are filtered in scanLine.
    re: /(api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    skipPath: TEST_OR_DOC },

  // ── Destructive data operations ─────────────────────────
  { id: "drop", label: "Destructive schema change", severity: "high", on: "add",
    why: "Drops or truncates data. Make sure there is a backup and a rollback plan.",
    re: /\b(DROP\s+(TABLE|COLUMN|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+(TABLE\s+)?\w|ALTER\s+TABLE\s+\w+\s+DROP|dropTable|dropColumn|remove_column|drop_table|op\.drop_)/i },
  { id: "mass-delete", label: "Unscoped delete or update", severity: "high", on: "add",
    why: "Deletes or updates rows without an obvious filter. Check the WHERE clause.",
    re: /\b(DELETE\s+FROM\s+["'`\w.]+\s*(;|$|["'`])|UPDATE\s+["'`\w.]+\s+SET\s+[^;]*$|deleteMany\(\s*(\{\s*\})?\s*\)|\.delete\(\)\s*$|rm\s+-rf\s+[/$~])/i,
    skipPath: TEST_OR_DOC },

  // ── Code execution & injection ──────────────────────────
  { id: "exec", label: "Dynamic code or shell execution", severity: "high", on: "add",
    why: "Runs code or shell commands built at runtime: a classic injection path.",
    re: /\b(eval\s*\(|new\s+Function\s*\(|child_process|execSync\s*\(|exec\s*\(|spawn\s*\(|os\.system\s*\(|subprocess\.(call|run|Popen)\([^)]*shell\s*=\s*True|shell_exec\s*\(|Runtime\.getRuntime\(\)\.exec)/,
    skipPath: TEST_OR_DOC },
  { id: "sql-concat", label: "SQL built from strings", severity: "high", on: "add",
    why: "Query text is built with interpolation: use parameters to avoid SQL injection.",
    re: /(SELECT|INSERT|UPDATE|DELETE)\b[^;]*(\$\{|"\s*\+\s*\w|'\s*\+\s*\w|%s'|f"[^"]*\{)|\.(raw|query|execute)\(\s*`[^`]*\$\{|\$queryRawUnsafe|\$executeRawUnsafe/i,
    skipPath: TEST_OR_DOC },
  { id: "xss", label: "Raw HTML injection", severity: "medium", on: "add",
    why: "Inserts HTML without escaping. Make sure the content is sanitized.",
    re: /dangerouslySetInnerHTML|\.innerHTML\s*=|v-html=|\{\{\{|\|\s*safe\b|mark_safe\(|html_safe|bypassSecurityTrust/ },

  // ── Auth & security posture ─────────────────────────────
  { id: "auth-removed", label: "Auth check removed", severity: "high", on: "del",
    why: "A line that looks like an authentication, permission or signature check was deleted.",
    re: /\b(constructEvent|verifySignature|verify_signature|verifyWebhook|timingSafeEqual|compare_digest|requireAuth|isAuthenticated|ensureAuth|checkPermission|authorize|can\(|hasRole|isAdmin|@login_required|@requires_auth|login_required|verifyToken|jwt\.verify|getServerSession|auth\(\)|currentUser|permission_classes|@UseGuards|protect\b)/,
    skipPath: TEST_OR_DOC },
  { id: "auth-touched", label: "Auth logic changed", severity: "low", on: "add",
    why: "Touches authentication, sessions or permissions: confirm who can now do what.",
    re: /\b(jwt|bcrypt|argon2|session|cookie|csrf|oauth|password|permission|role|isAdmin|authorize|authenticate|signIn|signOut|login|logout|token)\b/i,
    skipPath: TEST_OR_DOC },
  { id: "security-off", label: "Security setting weakened", severity: "high", on: "add",
    why: "Turns off a safety check (TLS, CORS, CSRF, sandbox, verification).",
    re: /(verify\s*=\s*False|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|InsecureSkipVerify\s*:\s*true|Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*|origin\s*:\s*(["']\*["']|true)|csrf\s*[:=]\s*false|@csrf_exempt|--no-verify|allowAll|permitAll\(\)|sandbox\s*:\s*false|disable_?auth)/i },
  { id: "debug", label: "Debug flag on", severity: "medium", on: "add",
    why: "Debug mode or verbose errors can leak internals in production.",
    re: /\b(DEBUG\s*[:=]\s*(True|true|1|["']true["'])|debug\s*:\s*true|app\.run\([^)]*debug\s*=\s*True)/,
    skipPath: TEST_OR_DOC },

  // ── Money ───────────────────────────────────────────────
  { id: "money-api", label: "Payment API call", severity: "medium", on: "add",
    why: "Creates, changes or refunds a real payment: check amounts, currency units and idempotency.",
    re: /\b(stripe|paddle|braintree|paypal|lemonsqueezy|razorpay|adyen)\.\w+\.(create|update|del|cancel|capture|refund|confirm)\b|\b(paymentIntents|charges|refunds|payouts|transfers|subscriptions|invoices)\.(create|update|cancel|del|pay|finalize\w*)\(|idempotency[_-]?key/i,
    skipPath: TEST_OR_DOC },
  { id: "money", label: "Money math", severity: "low", on: "add",
    why: "Touches prices or balances: watch rounding, cents vs dollars and currency.",
    re: /\b(price|amount|balance|currency|refund|payout|invoice|discount|coupon|tax|fee)s?\b[^=]*[=*+\-/]|\b(toFixed|Math\.round)\([^)]*\b(price|amount|total)\b/i,
    skipPath: /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|docs?)\/|\.(test|spec)\.\w+$|\.(md|mdx|rst|txt|sql|prisma)$|(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile)$/i },

  // ── Error handling & reliability ────────────────────────
  { id: "swallow", label: "Error swallowed", severity: "medium", on: "add",
    why: "An error is caught and ignored, so failures will be silent.",
    re: /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|except(\s+\w+(\s+as\s+\w+)?)?\s*:\s*pass|\.catch\(\s*\(\s*\)\s*=>\s*(\{\s*\}|null|undefined)\s*\)|rescue\s*=>?\s*nil|_ = err\b/ },
  { id: "test-disabled", label: "Test skipped or weakened", severity: "medium", on: "add",
    why: "A test was skipped, focused or loosened: agents do this to make CI green.",
    re: /\b(it|test|describe)\.(skip|only|todo)\(|\bx(it|describe)\(|@pytest\.mark\.skip\b(?!if)|\bpytest\.skip\(|@unittest\.skip\b(?!If|Unless)|@Disabled|t\.Skip\(|expect\(true\)\.toBe\(true\)|assert True\b|toMatchSnapshot\(\)/ },
  { id: "type-escape", label: "Type safety bypassed", severity: "low", on: "add",
    why: "Silences the type checker or linter instead of fixing the cause.",
    re: /(@ts-ignore|@ts-nocheck|@ts-expect-error|as\s+any\b|:\s*any\b|eslint-disable|# type:\s*ignore|# noqa|#\[allow\(|nolint|unsafe\s*\{)/,
    skipPath: TEST_OR_DOC },
  { id: "todo", label: "TODO or placeholder", severity: "low", on: "add",
    why: "Unfinished work or a stub left in the code.",
    re: /\b(TODO|FIXME|HACK|XXX)\b|not implemented|NotImplementedError|throw new Error\(["']TODO|placeholder|lorem ipsum/i },
  { id: "console", label: "Debug output left in", severity: "low", on: "add",
    why: "A console/print statement that probably shouldn't ship.",
    re: /\b(console\.(log|debug|trace)|debugger;|print\(|pp\s|var_dump\(|dd\(|binding\.pry|fmt\.Println\()/,
    skipPath: /(^|\/)(scripts?|bin|cli|tools?)\/|cli\.\w+$|\.(md|mdx)$|(^|\/)(tests?|__tests__)\// },

  // ── Concurrency / network ───────────────────────────────
  { id: "network", label: "New outbound call", severity: "low", on: "add",
    why: "Sends data to a network endpoint: check what is sent and where.",
    re: /\b(fetch\(\s*["'`]https?:|axios\.(get|post|put|delete)\(|requests\.(get|post|put|delete)\(|http\.(Get|Post)\(|new\s+WebSocket\()/,
    skipPath: TEST_OR_DOC },
];

/** A dependency entry such as "zod": "^3.2" or requests==2.31 (not the package's own version field). */
const DEP_LINE = /["']?[@\w./-]+["']?\s*([:=]|==|>=|~=)\s*["']?[\^~>=<]*\d/;
const OWN_VERSION = /^\s*["']?(version|packageManager|node|engines)["']?\s*[:=]/;
const ASSERTION = /\b(expect\(|assert(Equal|True|False|_called|_eq|_eq!)?\b|should\.|t\.(Error|Fatal)|\.toBe\(|\.toEqual\()/;
const TEST_FILE = /(\.(test|spec)\.\w+$|_test\.\w+$|(^|\/)tests?\/)/;

interface FileRule { id: string; label: string; severity: Severity; why: string; test: (f: FileDiff) => boolean }

const FILE_RULES: FileRule[] = [
  { id: "env-file", label: "Environment file changed", severity: "high",
    why: "Env files often hold secrets and should rarely be committed.",
    test: (f) => /(^|\/)\.env(\.[\w.-]+)?$/.test(f.path) && !/\.(example|sample|template)$/.test(f.path) },
  { id: "ci-changed", label: "CI / deploy pipeline changed", severity: "medium",
    why: "Changes how code is tested or deployed. A favourite place to hide a bypass.",
    test: (f) => /(^|\/)(\.github\/workflows|\.gitlab-ci|\.circleci|Jenkinsfile|vercel\.json|netlify\.toml|Dockerfile)/.test(f.path) },
  { id: "migration", label: "Database migration", severity: "medium",
    why: "Runs against production data: check it is reversible and safe on big tables.",
    test: (f) => /(^|\/)(migrations?|alembic\/versions|prisma\/migrations|db\/migrate)\//i.test(f.path) },
  { id: "deleted-test", label: "Test file deleted", severity: "high",
    why: "A whole test file was removed. Was the behaviour removed too?",
    test: (f) => f.status === "deleted" && TEST_FILE.test(f.path) },
  { id: "huge-file", label: "Very large change", severity: "low",
    why: "Over 400 changed lines in one file: consider asking for it to be split.",
    test: (f) => f.layer !== "generated" && f.additions + f.deletions > 400 },
  { id: "new-dep", label: "Dependency added or bumped", severity: "medium",
    why: "New third-party code. Check the package name for typos (typosquatting) and maintenance.",
    test: (f) => f.layer === "deps" && f.hunks.some((h) => h.lines.some((l) => l.kind === "add" && DEP_LINE.test(l.text) && !OWN_VERSION.test(l.text))) },
];

const PLACEHOLDER = /["'](\$\{|<|\{\{|process\.env|your[_-]|example|changeme|placeholder|dummy|fake|test|xxx|\*{3,}|\.{3})|(secret|password|token)["']\s*[:=]\s*["'](secret|password|token)/i;
const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|export\s+\*?\s*\{?[^=]*\}?\s*from\b|(const|let|var)\s+[\w{}\s,]+=\s*require\(|use\s+[\w:]+;|#include\b)/;
/** Rules that are about behaviour, so an import line alone is not evidence. */
const BEHAVIOUR_RULES = new Set(["auth-removed", "auth-touched", "money", "money-api", "exec", "network"]);

function scanLine(path: string, line: DiffLine): RiskHit[] {
  const hits: RiskHit[] = [];
  const text = line.text;
  if (text.trim().length < 3 || text.length > 2000) return hits;
  const isImport = IMPORT_LINE.test(text);
  for (const r of LINE_RULES) {
    if (r.on !== "both" && r.on !== line.kind) continue;
    if (r.skipPath?.test(path)) continue;
    if (isImport && BEHAVIOUR_RULES.has(r.id)) continue;
    if (r.id === "secret-assign" && PLACEHOLDER.test(text)) continue;
    if (r.re.test(text)) hits.push({ rule: r.id, label: r.label, severity: r.severity, why: r.why });
  }
  // Keep a line readable: at most the two most severe hits.
  return hits.sort((a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity]).slice(0, 2);
}

/** Annotate every line and file with risk hits, and compute file risk scores. */
export function scoreRisks(files: FileDiff[]): void {
  // A test file deleted here and re-added under the same name elsewhere was moved, not lost.
  // Assertions can move between test files; only a net loss across the whole diff counts.
  const count = (f: FileDiff, kind: "add" | "del") =>
    f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === kind && ASSERTION.test(l.text)).length, 0);
  const testFiles = files.filter((f) => TEST_FILE.test(f.path));
  const netLoss = testFiles.reduce((n, f) => n + count(f, "del") - count(f, "add"), 0) > 0;
  const stem = (p: string) => (p.split("/").pop() ?? p).replace(/\.[cm]?[jt]sx?$|\.\w+$/, "");
  const addedNames = new Set(files.filter((f) => f.status === "added").map((f) => stem(f.path)));
  for (const f of files) {
    if (f.layer === "generated") continue;
    let max = 0;
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.kind === "ctx") continue;
        l.risks = scanLine(f.path, l);
        for (const r of l.risks) max = Math.max(max, SEVERITY_SCORE[r.severity]);
      }
    }
    // Edited assertions are fine; a test file that ends up with fewer of them is worth a look.
    const assertsOut = count(f, "del");
    const assertsIn = count(f, "add");
    f.fileRisks = FILE_RULES.filter((r) => r.test(f))
      .filter((r) => !(r.id === "deleted-test" && addedNames.has(stem(f.path))))
      .map((r) => ({ rule: r.id, label: r.label, severity: r.severity, why: r.why }));
    if (netLoss && assertsOut > assertsIn && TEST_FILE.test(f.path) && f.status !== "deleted") {
      f.fileRisks.push({
        rule: "fewer-assertions",
        label: `Fewer assertions (${assertsOut} removed, ${assertsIn} added)`,
        severity: "medium",
        why: "This test file checks less than it did. Make sure the behaviour is still verified.",
      });
    }
    for (const r of f.fileRisks) max = Math.max(max, SEVERITY_SCORE[r.severity]);
    f.riskScore = max;
  }
}
