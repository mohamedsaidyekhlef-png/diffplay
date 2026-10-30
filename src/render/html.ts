import { LAYER_META } from "../classify.js";
import type { DiffLine, FileDiff, Severity, Step, Walkthrough } from "../types.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const SEV_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };
const lineSev = (l: DiffLine): Severity | "none" =>
  l.risks.reduce<Severity | "none">((m, r) => (SEV_RANK[r.severity] > SEV_RANK[m] ? r.severity : m), "none");

const RISK_WORD: Record<string, string> = { high: "High risk", medium: "Worth a check", low: "Minor", none: "Clean" };

let lineCounter = 0;
const lineId = () => `L${++lineCounter}`;
/** "path:line" → anchor id, so summaries can link straight to a line. */
const anchors = new Map<string, string>();

interface Cell { id: string; sev: Severity | "none"; kind: "add" | "del"; step: number }

function renderLine(path: string, l: DiffLine, cells: Cell[], step: number): string {
  const sev = lineSev(l);
  const id = l.kind === "ctx" ? "" : lineId();
  if (id) {
    cells.push({ id, sev, kind: l.kind as "add" | "del", step });
    const key = `${path}:${l.newNo ?? l.oldNo}`;
    if (!anchors.has(key)) anchors.set(key, id);
  }
  const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
  const notes = l.risks.length
    ? `<tr class="note sev-${sev}"><td colspan="3"><div class="note-body">${l.risks
        .map((r) => `<p><strong>${esc(r.label)}.</strong> ${esc(r.why)}</p>`)
        .join("")}</div></td></tr>`
    : "";
  return `<tr class="ln ${l.kind}${sev !== "none" ? ` flag sev-${sev}` : ""}"${id ? ` id="${id}"` : ""}><td class="no">${l.oldNo ?? ""}</td><td class="no">${l.newNo ?? ""}</td><td class="code"><span class="sign">${sign}</span>${esc(l.text) || " "}</td></tr>${notes}`;
}

function renderFile(f: FileDiff, cells: Cell[], step: number): string {
  const changed = f.additions + f.deletions;
  const sev = (["none", "low", "medium", "high"] as const)[f.riskScore];
  const open = f.riskScore >= 2 || changed <= 80 || f.status === "added" && changed <= 150;
  const statusWord = { added: "new file", deleted: "deleted", renamed: "renamed", modified: "" }[f.status];
  const fileNotes = f.fileRisks.length
    ? `<ul class="file-notes">${f.fileRisks.map((r) => `<li class="sev-${r.severity}"><strong>${esc(r.label)}.</strong> ${esc(r.why)}</li>`).join("")}</ul>`
    : "";
  const body = f.binary
    ? `<p class="empty">Binary file, not shown.</p>`
    : f.hunks
        .map(
          (h) =>
            `<tbody><tr class="hunk"><td colspan="3">${esc(h.section ? h.section.trim() : `Lines ${h.newStart}+`)}</td></tr>${h.lines
              .map((l) => renderLine(f.path, l, cells, step))
              .join("")}</tbody>`,
        )
        .join("");
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
  const base = f.path.slice(dir.length);
  return `<details class="file sev-${sev}"${open ? " open" : ""}>
<summary><span class="risk-dot" title="${RISK_WORD[sev]}"></span><span class="path"><span class="dir">${esc(dir)}</span>${esc(base)}</span>${statusWord ? `<span class="status">${statusWord}</span>` : ""}<span class="delta"><span class="plus">+${f.additions}</span> <span class="minus">−${f.deletions}</span></span></summary>
${fileNotes}${f.binary ? body : `<div class="scroll"><table class="diff">${body}</table></div>`}
</details>`;
}

function renderStep(s: Step, total: number, cells: Cell[]): string {
  const meta = LAYER_META[s.layer];
  const add = s.files.reduce((n, f) => n + f.additions, 0);
  const del = s.files.reduce((n, f) => n + f.deletions, 0);
  return `<section class="step sev-${s.risk}" id="step-${s.id}" data-step="${s.id}" aria-labelledby="h-step-${s.id}">
<header class="step-head">
  <span class="step-no" aria-hidden="true">${s.id}</span>
  <div>
    <h2 id="h-step-${s.id}">${esc(s.title)}</h2>
    <p class="step-meta">Step ${s.id} of ${total}. ${s.files.length} file${s.files.length === 1 ? "" : "s"}, <span class="plus">+${add}</span> <span class="minus">−${del}</span>${s.risk !== "none" ? `. <span class="risk-word sev-${s.risk}">${RISK_WORD[s.risk]}</span>` : ""}</p>
  </div>
</header>
<p class="narration">${esc(s.narration)}</p>
${s.files.map((f) => renderFile(f, cells, s.id)).join("\n")}
</section>`;
}

function heatmap(cells: Cell[]): string {
  const MAX = 480;
  let buckets: Cell[] = cells;
  if (cells.length > MAX) {
    const size = cells.length / MAX;
    buckets = [];
    for (let i = 0; i < MAX; i++) {
      const slice = cells.slice(Math.floor(i * size), Math.floor((i + 1) * size));
      if (!slice.length) continue;
      const worst = slice.reduce((a, b) => (SEV_RANK[b.sev] > SEV_RANK[a.sev] ? b : a));
      buckets.push(worst);
    }
  }
  return buckets
    .map((c, i) => {
      const stepChange = i > 0 && buckets[i - 1].step !== c.step ? " gap" : "";
      return `<a class="cell ${c.sev === "none" ? c.kind : `sev-${c.sev}`}${stepChange}" href="#${c.id}" tabindex="-1" aria-hidden="true"></a>`;
    })
    .join("");
}

export function renderHtml(w: Walkthrough): string {
  lineCounter = 0;
  anchors.clear();
  const cells: Cell[] = [];
  const stepsHtml = w.steps.map((s) => renderStep(s, w.steps.length, cells)).join("\n");
  const { stats } = w;

  const rail = w.steps
    .map((s) => `<li><a href="#step-${s.id}" data-step="${s.id}" class="sev-${s.risk}"><span class="rail-no">${s.id}</span><span class="rail-title">${esc(s.title)}</span><span class="risk-dot" title="${RISK_WORD[s.risk]}"></span></a></li>`)
    .join("");

  // "Read these first" points at real line anchors where we have them.
  const firstLook = w.topRisks.slice(0, 6).map((r) => {
    const anchor = r.line != null ? anchors.get(`${r.file}:${r.line}`) : undefined;
    const label = `<strong>${esc(r.hit.label)}</strong> in <code>${esc(r.file.split("/").pop() ?? r.file)}${r.line != null ? `:${r.line}` : ""}</code>${r.text ? `<span class="snippet">${esc(r.text.slice(0, 90))}</span>` : ""}`;
    return `<li class="sev-${r.hit.severity}"><span class="risk-dot"></span>${anchor ? `<a class="jump" href="#${anchor}">${label}</a>` : `<span>${label}</span>`}</li>`;
  });

  const hidden = w.hiddenFiles.length
    ? `<section class="hidden-files"><details><summary>${w.hiddenFiles.length} generated, lock or renamed file${w.hiddenFiles.length === 1 ? "" : "s"} hidden</summary><ul>${w.hiddenFiles.map((f) => `<li><code>${esc(f.path)}</code> <span class="plus">+${f.additions}</span> <span class="minus">−${f.deletions}</span></li>`).join("")}</ul></details></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(w.title)} · diffplay</title>
<meta name="description" content="${esc(w.summary)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#steps">Skip to the walkthrough</a>
<header class="hero">
  <div class="wrap">
    <p class="source">${esc(w.source)}</p>
    <h1>${esc(w.title)}</h1>
    <p class="summary">${esc(w.summary)}</p>
    <dl class="numbers">
      <div><dt>Files</dt><dd>${stats.files}</dd></div>
      <div><dt>Lines</dt><dd><span class="plus">+${stats.additions}</span> <span class="minus">−${stats.deletions}</span></dd></div>
      <div><dt>Read closely</dt><dd>${stats.focusPercent}%<small> of the diff</small></dd></div>
      <div><dt>Flags</dt><dd><span class="count sev-high">${stats.risks.high}</span><span class="count sev-medium">${stats.risks.medium}</span><span class="count sev-low">${stats.risks.low}</span></dd></div>
    </dl>
  </div>
  <div class="wrap">
    <div class="strip" role="img" aria-label="Every changed line in reading order, colored by risk. ${stats.risks.high} high, ${stats.risks.medium} medium, ${stats.risks.low} minor flags.">${heatmap(cells)}</div>
    <p class="legend"><span><i class="k add"></i>Added</span><span><i class="k del"></i>Removed</span><span><i class="k sev-low"></i>Minor</span><span><i class="k sev-medium"></i>Worth a check</span><span><i class="k sev-high"></i>High risk</span><span class="hint">Click the strip to jump. Keys: <kbd>j</kbd> <kbd>k</kbd> step, <kbd>n</kbd> next flag.</span></p>
  </div>
</header>
${firstLook.length ? `<section class="wrap first-look" aria-labelledby="fl"><h2 id="fl">Read these first</h2><ul>${firstLook.join("")}</ul></section>` : ""}
<div class="wrap layout">
  <nav class="rail" aria-label="Steps"><ol>${rail}</ol></nav>
  <main id="steps">
${stepsHtml}
${hidden}
<footer class="foot">
  <p>Narration by ${esc(w.narratedBy)}. Risk flags come from static rules: they point at places to look, they are not a verdict. Generated ${esc(w.generatedAt.slice(0, 16).replace("T", " "))} UTC by <a href="https://github.com/mohamedsaidyekhlef-png/diffplay">diffplay</a>.</p>
</footer>
  </main>
</div>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = String.raw`
:root{
  --bg:#E9EDF2; --paper:#FFFFFF; --ink:#18212F; --muted:#5A6577; --line:#D3DAE3; --soft:#F3F5F8;
  --add:#2F7A57; --add-bg:#E6F3EC; --del:#A8394F; --del-bg:#F8E8EC;
  --low:#7B92B2; --med:#D99A12; --high:#D3263A; --high-bg:#FDECEE; --med-bg:#FDF5E2;
  --focus:#3346D3; --cell-add:#B9D7C8; --cell-del:#E4BCC6;
  --sans:"Schibsted Grotesk",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#141A24; --paper:#1B2230; --ink:#E7ECF3; --muted:#9AA6B8; --line:#2C3546; --soft:#212A3A;
  --add:#6FCB9C; --add-bg:#1C3029; --del:#F08BA0; --del-bg:#3A2029;
  --low:#8EA6C8; --med:#F2B63A; --high:#FF5A6A; --high-bg:#3D1E25; --med-bg:#362C17;
  --focus:#8C99FF; --cell-add:#2F5644; --cell-del:#5C2F3B; color-scheme:dark;
}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:16px}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;background:var(--paper);padding:8px 12px;z-index:9}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
.plus{color:var(--add);font-family:var(--mono);font-size:.92em}.minus{color:var(--del);font-family:var(--mono);font-size:.92em}

/* Hero */
.hero{padding:40px 0 24px;background:var(--paper);border-bottom:1px solid var(--line)}
.source{margin:0 0 6px;color:var(--muted);font-size:14px;word-break:break-all}
h1{font-size:clamp(28px,4.4vw,46px);line-height:1.08;letter-spacing:-.02em;font-weight:800;margin:0 0 14px;max-width:22ch}
.summary{font-size:18px;max-width:62ch;margin:0 0 24px;color:var(--ink)}
.numbers{display:flex;flex-wrap:wrap;gap:12px 36px;margin:0 0 28px}
.numbers div{min-width:0}.numbers dt{font-size:13px;color:var(--muted)}
.numbers dd{margin:0;font-size:22px;font-weight:700;display:flex;gap:6px;align-items:baseline}
.numbers small{font-size:13px;font-weight:400;color:var(--muted)}
.count{font-family:var(--mono);font-size:15px;padding:1px 8px;border-radius:999px;font-weight:600}
.count.sev-high{background:var(--high-bg);color:var(--high)}.count.sev-medium{background:var(--med-bg);color:var(--med)}.count.sev-low{background:var(--soft);color:var(--low)}

/* The strip: the whole diff at a glance */
.strip{display:flex;height:56px;gap:1px;border-radius:6px;overflow:hidden;background:var(--soft)}
.cell{flex:1 1 0;min-width:1px;background:var(--cell-add);transition:transform .12s}
.cell.del{background:var(--cell-del)}
.cell.sev-low{background:var(--low)}.cell.sev-medium{background:var(--med)}.cell.sev-high{background:var(--high)}
.cell.gap{margin-left:3px}
.cell:hover{transform:scaleY(1.12)}
.hero .strip .cell.sev-high{animation:pulse 1.6s ease-out 1 .4s}
@keyframes pulse{0%{filter:none}40%{filter:brightness(1.35)}100%{filter:none}}
@media (prefers-reduced-motion:reduce){.hero .strip .cell.sev-high{animation:none}.cell{transition:none}}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted);margin:10px 0 0}
.legend span{display:inline-flex;align-items:center;gap:6px}
.k{display:inline-block;width:12px;height:12px;border-radius:2px}
.k.add{background:var(--cell-add)}.k.del{background:var(--cell-del)}.k.sev-low{background:var(--low)}.k.sev-medium{background:var(--med)}.k.sev-high{background:var(--high)}
.legend .hint{margin-left:auto}
kbd{font-family:var(--mono);font-size:12px;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;background:var(--paper)}

/* Read these first */
.first-look{margin-top:28px}
.first-look h2{font-size:20px;margin:0 0 10px}
.first-look ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:8px}
.first-look li{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:var(--paper);border:1px solid var(--line);border-radius:8px;font-size:14px;min-width:0}
.first-look li>span:last-child,.first-look .jump{min-width:0;text-decoration:none}
.first-look .jump:hover strong{text-decoration:underline}
.first-look code{font-family:var(--mono);font-size:13px}
.snippet{display:block;font-family:var(--mono);font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.risk-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--line);margin-top:6px}
.sev-high>.risk-dot,.sev-high .risk-dot{background:var(--high)}
.sev-medium>.risk-dot,.sev-medium .risk-dot{background:var(--med)}
.sev-low>.risk-dot,.sev-low .risk-dot{background:var(--low)}

/* Layout */
.layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:32px;margin-top:32px;align-items:start}
main{min-width:0}
.rail{position:sticky;top:16px}
.rail ol{list-style:none;margin:0;padding:0;border-left:2px solid var(--line)}
.rail a{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px;margin-left:-2px;border-left:2px solid transparent;text-decoration:none;color:var(--muted);font-size:15px}
.rail a .risk-dot{margin:0 0 0 auto}
.rail a:hover{color:var(--ink)}
.rail a.active{border-left-color:var(--ink);color:var(--ink);font-weight:700}
.rail-no{font-family:var(--mono);font-size:13px;width:18px}
.rail a.sev-none .risk-dot{visibility:hidden}

/* Steps */
.step{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:24px;margin-bottom:24px;scroll-margin-top:16px}
.step.sev-high{border-color:color-mix(in srgb,var(--high) 45%,var(--line))}
.step-head{display:flex;gap:14px;align-items:flex-start}
.step-no{flex:none;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:18px;background:var(--ink);color:var(--paper)}
.step h2{font-size:24px;line-height:1.2;margin:4px 0 2px;letter-spacing:-.01em}
.step-meta{margin:0;color:var(--muted);font-size:14px}
.risk-word.sev-high{color:var(--high);font-weight:700}.risk-word.sev-medium{color:var(--med);font-weight:700}.risk-word.sev-low{color:var(--low)}
.narration{font-size:17px;max-width:68ch;margin:16px 0 20px;padding-left:54px}
@media (max-width:640px){.narration{padding-left:0}}

/* Files */
.file{border:1px solid var(--line);border-radius:8px;margin-top:12px;overflow:hidden;background:var(--paper)}
.file>summary{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;background:var(--soft);list-style:none;font-size:14px}
.file>summary::-webkit-details-marker{display:none}
.file>summary::before{content:"";width:7px;height:7px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .15s;flex:none}
.file[open]>summary::before{transform:rotate(45deg)}
.file .risk-dot{margin-top:0}
.path{font-family:var(--mono);font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dir{color:var(--muted)}
.status{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:0 8px;white-space:nowrap}
.delta{margin-left:auto;white-space:nowrap}
.file-notes{list-style:none;margin:0;padding:10px 14px;border-top:1px solid var(--line);font-size:14px;display:grid;gap:4px}
.file-notes li{padding-left:12px;border-left:3px solid var(--low)}
.file-notes li.sev-high{border-color:var(--high)}.file-notes li.sev-medium{border-color:var(--med)}
.scroll{overflow-x:auto;border-top:1px solid var(--line)}
.diff{border-collapse:collapse;width:100%;font:13px/1.6 var(--mono)}
.diff td{padding:0 10px;vertical-align:top}
.diff .no{width:1%;min-width:44px;text-align:right;color:var(--muted);opacity:.6;user-select:none;font-size:12px}
.diff .code{white-space:pre;width:98%}
.sign{display:inline-block;width:14px;color:var(--muted);user-select:none}
.ln.ctx .code{color:var(--muted)}
.ln.add{background:var(--add-bg)}.ln.del{background:var(--del-bg)}
.ln.flag{box-shadow:inset 4px 0 0 var(--low)}
.ln.flag.sev-medium{box-shadow:inset 4px 0 0 var(--med)}
.ln.flag.sev-high{box-shadow:inset 4px 0 0 var(--high)}
.ln:target,.ln.lit{outline:2px solid var(--focus);outline-offset:-2px}
.hunk td{padding:6px 10px;color:var(--muted);background:var(--soft);font-family:var(--sans);font-size:12.5px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.note td{padding:0}
.note-body{font-family:var(--sans);font-size:13.5px;line-height:1.45;padding:8px 14px 8px 58px;background:var(--soft);border-left:4px solid var(--low)}
.note.sev-medium .note-body{background:var(--med-bg);border-color:var(--med)}
.note.sev-high .note-body{background:var(--high-bg);border-color:var(--high)}
.note-body p{margin:0;white-space:normal;max-width:80ch}
.empty{padding:12px 14px;margin:0;color:var(--muted)}
.hidden-files{margin:8px 0 24px;color:var(--muted);font-size:14px}
.hidden-files summary{cursor:pointer}
.hidden-files ul{padding-left:18px}
.foot{color:var(--muted);font-size:13px;padding:8px 0 48px;max-width:70ch}

@media (max-width:860px){
  .layout{grid-template-columns:minmax(0,1fr);gap:16px}
  .rail{position:sticky;top:0;z-index:5;background:var(--bg);padding:8px 0;margin:0 -16px;padding-left:16px}
  .rail ol{display:flex;overflow-x:auto;border-left:0;gap:6px;padding-right:16px}
  .rail a{border:1px solid var(--line);border-radius:999px;background:var(--paper);white-space:nowrap;margin:0;padding:6px 12px}
  .rail a.active{border-color:var(--ink)}
  .rail-title{max-width:16ch;overflow:hidden;text-overflow:ellipsis}
  .step{padding:16px}
  .legend .hint{display:none}
  .numbers{gap:12px 24px}
  html{scroll-padding-top:64px}.step{scroll-margin-top:64px}
}
@media print{.rail,.legend .hint,.skip{display:none}.layout{display:block}.file{break-inside:avoid}details>*{display:block}}
`;

const JS = String.raw`(()=>{
const steps=[...document.querySelectorAll('.step')];
const links=[...document.querySelectorAll('.rail a')];
const setActive=id=>links.forEach(a=>a.classList.toggle('active',a.dataset.step===id));
if('IntersectionObserver' in window){
  const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting)setActive(e.target.dataset.step)})},{rootMargin:'-20% 0px -70% 0px'});
  steps.forEach(s=>io.observe(s));
}
const current=()=>{let i=0;steps.forEach((s,k)=>{if(s.getBoundingClientRect().top<120)i=k});return i};
const flags=[...document.querySelectorAll('.ln.flag.sev-high, .ln.flag.sev-medium')];
let f=-1;
const reveal=el=>{const d=el.closest('details');if(d)d.open=true;document.querySelectorAll('.lit').forEach(x=>x.classList.remove('lit'));el.classList.add('lit');el.scrollIntoView({block:'center'})};
document.addEventListener('click',e=>{const c=e.target.closest('.cell,.jump');if(!c)return;e.preventDefault();const t=document.getElementById(c.getAttribute('href').slice(1));if(t)reveal(t)});
document.addEventListener('keydown',e=>{
  if(e.target.closest('input,textarea')||e.metaKey||e.ctrlKey||e.altKey)return;
  if(e.key==='j'||e.key==='k'){const i=Math.min(steps.length-1,Math.max(0,current()+(e.key==='j'?1:-1)));steps[i].scrollIntoView();steps[i].querySelector('h2').focus?.()}
  if(e.key==='n'&&flags.length){f=(f+1)%flags.length;reveal(flags[f])}
});
})();`;
