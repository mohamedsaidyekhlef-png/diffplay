import { classify, LAYER_META, LAYER_ORDER } from "./classify.js";
import { parseDiff } from "./parse.js";
import { scoreRisks, SEVERITY_SCORE } from "./risk.js";
import type { FileDiff, Layer, Severity, Step, Walkthrough } from "./types.js";

const SCORE_TO_SEV: Record<number, Severity | "none"> = { 0: "none", 1: "low", 2: "medium", 3: "high" };

function fileHits(f: FileDiff) {
  const out: { line: number | null; hit: import("./types.js").RiskHit; text: string }[] = [];
  for (const h of f.hunks)
    for (const l of h.lines)
      for (const hit of l.risks) out.push({ line: l.newNo ?? l.oldNo, hit, text: l.text.trim() });
  return out;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Facts-only narration used when no model is configured. */
export function heuristicNarration(layer: Layer, files: FileDiff[]): string {
  const added = files.filter((f) => f.status === "added").map((f) => f.path.split("/").pop());
  const deleted = files.filter((f) => f.status === "deleted").map((f) => f.path.split("/").pop());
  const parts: string[] = [LAYER_META[layer].narration];
  if (added.length) parts.push(`New: ${added.slice(0, 3).join(", ")}${added.length > 3 ? ` +${added.length - 3} more` : ""}.`);
  if (deleted.length) parts.push(`Removed: ${deleted.slice(0, 3).join(", ")}${deleted.length > 3 ? ` +${deleted.length - 3} more` : ""}.`);
  const hits = files.flatMap((f) => [...f.fileRisks, ...fileHits(f).map((x) => x.hit)]);
  const serious = [...new Set(hits.filter((h) => h.severity !== "low").map((h) => h.label))];
  if (serious.length) parts.push(`Watch for: ${serious.slice(0, 3).map((l) => l.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())).join(", ")}.`);
  return parts.join(" ");
}

export interface BuildOptions {
  title?: string;
  source?: string;
}

/** Turn raw diff text into a story-ordered, risk-scored walkthrough. */
export function buildWalkthrough(diffText: string, opts: BuildOptions = {}): Walkthrough {
  const files = parseDiff(diffText);
  for (const f of files) f.layer = classify(f);
  scoreRisks(files);

  const hiddenFiles = files.filter((f) => f.layer === "generated" || (f.binary && f.hunks.length === 0) || (f.status === "renamed" && f.hunks.length === 0));
  const visible = files.filter((f) => !hiddenFiles.includes(f));

  const steps: Step[] = [];
  for (const layer of LAYER_ORDER) {
    const inLayer = visible
      .filter((f) => f.layer === layer)
      .sort((a, b) => b.riskScore - a.riskScore || b.additions + b.deletions - (a.additions + a.deletions));
    if (!inLayer.length) continue;
    const max = Math.max(...inLayer.map((f) => f.riskScore));
    steps.push({
      id: steps.length + 1,
      layer,
      title: LAYER_META[layer].title,
      narration: heuristicNarration(layer, inLayer),
      files: inLayer,
      risk: SCORE_TO_SEV[max],
    });
  }

  // Stats
  let additions = 0, deletions = 0, total = 0, focus = 0;
  const risks = { high: 0, medium: 0, low: 0 };
  const topRisks: Walkthrough["topRisks"] = [];
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
    if (hiddenFiles.includes(f)) continue;
    for (const r of f.fileRisks) {
      risks[r.severity]++;
      if (r.severity !== "low") topRisks.push({ file: f.path, line: null, hit: r, text: "" });
    }
    for (const h of f.hunks) {
      const changed = h.lines.filter((l) => l.kind !== "ctx").length;
      total += changed;
      if (h.lines.some((l) => l.risks.some((r) => r.severity !== "low"))) focus += changed;
    }
    for (const x of fileHits(f)) {
      risks[x.hit.severity]++;
      if (x.hit.severity !== "low") topRisks.push({ file: f.path, ...x });
    }
  }
  topRisks.sort((a, b) => SEVERITY_SCORE[b.hit.severity] - SEVERITY_SCORE[a.hit.severity]);
  // One entry per file + rule, so a single noisy pattern can't crowd out the rest.
  const seen = new Set<string>();
  const distinct = topRisks.filter((r) => {
    const k = `${r.file}|${r.hit.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const stats: Walkthrough["stats"] = {
    files: files.length,
    additions,
    deletions,
    hidden: hiddenFiles.length,
    risks,
    focusPercent: total ? Math.max(risks.high + risks.medium ? 1 : 0, Math.round((focus / total) * 100)) : 0,
  };

  const summary =
    `${plural(files.length, "file")} changed (+${additions} −${deletions}), told as ${plural(steps.length, "step")}. ` +
    (risks.high
      ? `${plural(risks.high, "high-risk spot")} ${risks.high === 1 ? "needs" : "need"} a careful look before merging.`
      : risks.medium
        ? `No high-risk spots; ${plural(risks.medium, "medium-risk spot")} worth a check.`
        : "No risky patterns detected. Still read the core logic.");

  return {
    title: opts.title ?? "Pull request walkthrough",
    summary,
    source: opts.source ?? "local diff",
    generatedAt: new Date().toISOString(),
    narratedBy: "built-in notes (no model key set)",
    stats,
    steps,
    hiddenFiles,
    topRisks: distinct.slice(0, 12),
  };
}
