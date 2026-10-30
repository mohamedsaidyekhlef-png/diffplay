#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectProvider, narrate } from "./narrate.js";
import { renderHtml } from "./render/html.js";
import { renderMarkdown } from "./render/markdown.js";
import { buildWalkthrough } from "./story.js";

const VERSION = "0.1.0";

const HELP = `diffplay ${VERSION}
Turn any diff or pull request into a guided, risk-ranked walkthrough.

Usage
  diffplay                         everything on this branch vs main, including uncommitted work
  diffplay HEAD~3                  any git revision or range (main..feature, abc123...def456)
  diffplay <github-pr-url>         a GitHub pull request (uses gh if installed, else the public .diff)
  diffplay --pr 128                a PR in the current repo (needs gh)
  diffplay --diff change.patch     a diff file;  or pipe one:  git diff | diffplay

Options
  -o, --out <file>      HTML output path (default: diffplay.html)
  --md [file]           also write a Markdown summary (PR comment); prints to stdout with no file
  --json <file>         write the walkthrough as JSON
  --title <text>        set the title instead of letting the model write one
  --no-ai               skip model narration even if a key is set
  --open                open the walkthrough in your browser
  --fail-on <level>     exit 2 if any flag at this level or above: high | medium | low
  -q, --quiet           no terminal summary
  -v, --version / -h, --help

Narration (optional, bring your own key; nothing leaves your machine otherwise)
  ANTHROPIC_API_KEY  |  OPENAI_API_KEY (+ OPENAI_BASE_URL)  |  DIFFPLAY_OLLAMA=1
  DIFFPLAY_MODEL overrides the model.`;

interface Args {
  target?: string;
  pr?: string;
  diff?: string;
  out: string;
  md?: string | true;
  json?: string;
  title?: string;
  ai: boolean;
  open: boolean;
  failOn?: "high" | "medium" | "low";
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { out: "diffplay.html", ai: true, open: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${k} needs a value`);
      return v;
    };
    switch (k) {
      case "-h": case "--help": console.log(HELP); process.exit(0);
      case "-v": case "--version": console.log(VERSION); process.exit(0);
      case "-o": case "--out": a.out = next(); break;
      case "--md": a.md = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true; break;
      case "--json": a.json = next(); break;
      case "--title": a.title = next(); break;
      case "--pr": a.pr = next(); break;
      case "--diff": a.diff = next(); break;
      case "--no-ai": a.ai = false; break;
      case "--open": a.open = true; break;
      case "-q": case "--quiet": a.quiet = true; break;
      case "--fail-on": {
        const v = next();
        if (!["high", "medium", "low"].includes(v)) fail("--fail-on must be high, medium or low");
        a.failOn = v as Args["failOn"];
        break;
      }
      default:
        if (k.startsWith("-")) fail(`Unknown option ${k}. Run diffplay --help.`);
        a.target = k;
    }
  }
  return a;
}

function fail(msg: string): never {
  console.error(`diffplay: ${msg}`);
  process.exit(1);
}

const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function tryGit(args: string[]): string | null {
  try { return sh("git", args).trim(); } catch { return null; }
}

function hasGh(): boolean {
  try { sh("gh", ["--version"]); return true; } catch { return false; }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface Input { diff: string; source: string; title?: string; body?: string }

async function fromGithubPr(ref: string): Promise<Input> {
  const m = ref.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (hasGh()) {
    try {
      const diff = sh("gh", ["pr", "diff", ref]);
      let title: string | undefined, body: string | undefined, url = ref;
      try {
        const meta = JSON.parse(sh("gh", ["pr", "view", ref, "--json", "title,body,url"]));
        ({ title, body } = meta);
        url = meta.url;
      } catch { /* metadata is optional */ }
      return { diff, source: url, title, body };
    } catch (e) {
      if (!m) fail(`gh could not read PR ${ref}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (!m) fail(`--pr ${ref} needs the GitHub CLI (gh). Install it, or pass the full PR URL.`);
  const [, owner, repo, num] = m;
  const res = await fetch(`https://patch-diff.githubusercontent.com/raw/${owner}/${repo}/pull/${num}.diff`);
  if (!res.ok) fail(`Could not download ${ref} (${res.status}). For private repos, install and log in to gh.`);
  let title: string | undefined, body: string | undefined;
  try {
    const meta = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${num}`, { headers: { accept: "application/vnd.github+json" } });
    if (meta.ok) ({ title, body } = (await meta.json()) as { title: string; body: string });
  } catch { /* optional */ }
  return { diff: await res.text(), source: `github.com/${owner}/${repo}/pull/${num}`, title, body };
}

async function getInput(a: Args): Promise<Input> {
  if (a.diff) return { diff: readFileSync(a.diff, "utf8"), source: a.diff };
  if (a.pr) return fromGithubPr(a.pr);
  if (a.target && /github\.com\/.+\/pull\/\d+/.test(a.target)) return fromGithubPr(a.target);
  if (!process.stdin.isTTY && !a.target) {
    const piped = await readStdin();
    if (piped.trim()) return { diff: piped, source: "stdin" };
  }
  if (tryGit(["rev-parse", "--is-inside-work-tree"]) !== "true") {
    fail("Not inside a git repository. Pass a PR URL, --diff <file>, or pipe a diff in.");
  }
  if (a.target) {
    const diff = tryGit(["diff", "--no-color", "-M", a.target]);
    if (diff === null) fail(`git could not diff "${a.target}".`);
    return { diff, source: `git diff ${a.target}` };
  }
  // Default: this branch (plus uncommitted work) against its base.
  const base = ["origin/HEAD", "origin/main", "origin/master", "main", "master"]
    .map((b) => tryGit(["merge-base", "HEAD", b]))
    .find((x) => x);
  const range = base ?? "HEAD";
  const diff = tryGit(["diff", "--no-color", "-M", range]) ?? "";
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
  return { diff, source: base ? `${branch} vs base ${base.slice(0, 7)} (incl. uncommitted)` : "uncommitted changes" };
}

function openFile(path: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch { /* best effort */ }
}

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { red: (s: string) => `\x1b[31m${s}\x1b[0m`, yel: (s: string) => `\x1b[33m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m` }
  : { red: (s: string) => s, yel: (s: string) => s, dim: (s: string) => s, b: (s: string) => s };

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const input = await getInput(a);
  if (!input.diff.trim()) {
    if (!a.quiet) console.log("diffplay: no changes to walk through.");
    return;
  }

  const w = buildWalkthrough(input.diff, { title: a.title ?? input.title, source: input.source });
  if (!w.steps.length) {
    if (!a.quiet) console.log("diffplay: only generated or binary files changed. Nothing to review.");
    return;
  }

  const provider = a.ai ? detectProvider() : null;
  if (provider) {
    if (!a.quiet) process.stderr.write(c.dim(`Narrating with ${provider.name} (${provider.model})…\n`));
    const titleLocked = Boolean(a.title);
    const keep = w.title;
    const r = await narrate(w, provider, input.body);
    if (titleLocked) w.title = keep;
    if (!r.ok && !a.quiet) process.stderr.write(c.yel(`Narration failed, using built-in notes: ${r.error}\n`));
  }

  const outPath = resolve(a.out);
  writeFileSync(outPath, renderHtml(w));
  if (a.json) writeFileSync(a.json, JSON.stringify(w, null, 2));
  if (a.md) {
    const md = renderMarkdown(w);
    if (a.md === true) console.log(md);
    else writeFileSync(a.md, md);
  }

  if (!a.quiet && a.md !== true) {
    const s = w.stats;
    console.log(`\n${c.b(w.title)}`);
    console.log(c.dim(w.summary));
    console.log(`\n${s.files} file${s.files === 1 ? "" : "s"}  +${s.additions} −${s.deletions}  ·  read closely: ${s.focusPercent}%  ·  ${c.red(`${s.risks.high} high`)}  ${c.yel(`${s.risks.medium} medium`)}  ${s.risks.low} minor\n`);
    for (const st of w.steps) {
      const tag = st.risk === "high" ? c.red("●") : st.risk === "medium" ? c.yel("●") : c.dim("○");
      console.log(`  ${tag} ${st.id}. ${st.title} ${c.dim(`(${st.files.length})`)}`);
    }
    for (const r of w.topRisks.filter((x) => x.hit.severity === "high").slice(0, 5)) {
      console.log(`     ${c.red("!")} ${r.hit.label}: ${r.file}${r.line != null ? `:${r.line}` : ""}`);
    }
    console.log(`\n→ ${outPath}\n`);
  }
  if (a.open) openFile(outPath);

  if (a.failOn) {
    const s = w.stats.risks;
    const hit = a.failOn === "high" ? s.high : a.failOn === "medium" ? s.high + s.medium : s.high + s.medium + s.low;
    if (hit > 0) {
      console.error(`diffplay: ${hit} flag(s) at "${a.failOn}" or above.`);
      process.exit(2);
    }
  }
}

main().catch((e) => fail((e as Error).message));
