import type { Walkthrough } from "../types.js";

const EMOJI: Record<string, string> = { high: "🔴", medium: "🟠", low: "🔵", none: "⚪" };
const WORD: Record<string, string> = { high: "high risk", medium: "worth a check", low: "minor", none: "clean" };

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Compact PR comment. `link` points at the full HTML walkthrough when there is one. */
export function renderMarkdown(w: Walkthrough, link?: string): string {
  const s = w.stats;
  const out: string[] = [];
  out.push(`<!-- diffplay -->`);
  out.push(`### ▶ diffplay: ${w.title}`);
  out.push("");
  out.push(w.summary);
  out.push("");
  out.push(
    `**${s.files} files** · <code>+${s.additions} −${s.deletions}</code> · read closely: **${s.focusPercent}%** of the diff · ` +
      `${EMOJI.high} ${s.risks.high} ${EMOJI.medium} ${s.risks.medium} ${EMOJI.low} ${s.risks.low}`,
  );
  if (link) out.push(`\n**[Open the guided walkthrough →](${link})**`);
  out.push("");

  if (w.topRisks.length) {
    out.push(`#### Read these first`);
    for (const r of w.topRisks.slice(0, 8)) {
      const where = `\`${r.file}${r.line != null ? `:${r.line}` : ""}\``;
      out.push(`- ${EMOJI[r.hit.severity]} **${r.hit.label}** in ${where}. ${r.hit.why}`);
    }
    out.push("");
  }

  out.push(`#### The story, in reading order`);
  out.push(`| # | Step | Files | Risk | What it does |`);
  out.push(`|---|---|---|---|---|`);
  for (const st of w.steps) {
    out.push(`| ${st.id} | ${cell(st.title)} | ${st.files.length} | ${EMOJI[st.risk]} ${WORD[st.risk]} | ${cell(st.narration)} |`);
  }
  if (w.hiddenFiles.length) out.push(`\n<sub>${w.hiddenFiles.length} generated, lock or renamed files hidden.</sub>`);
  out.push(`\n<sub>Narration: ${w.narratedBy}. Flags are static rules pointing at places to look, not a verdict. Made with [diffplay](https://github.com/mohamedsaidyekhlef-png/diffplay).</sub>`);
  return out.join("\n");
}
