import type { DiffLine, FileDiff, FileStatus, Hunk } from "./types.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Undo git's C-style path quoting: "src/\303\274.ts" → src/ü.ts */
export function unquotePath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      const nx = body[i + 1];
      if (/[0-7]/.test(nx)) {
        bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
        i += 3;
        continue;
      }
      if (nx in simple) { bytes.push(simple[nx]); i++; continue; }
    }
    for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return unquotePath(p).replace(/^[ab]\//, "");
}

function emptyFile(oldPath: string, newPath: string): FileDiff {
  return {
    oldPath,
    newPath,
    path: newPath,
    status: "modified",
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    layer: "core",
    riskScore: 0,
    fileRisks: [],
  };
}

/**
 * Parse a unified diff (git diff, gh pr diff, a .patch, or plain diff -u)
 * into files and hunks. Hunk bodies are consumed by their declared line
 * counts, so deleted lines like "-- sql comment" never get mistaken for headers.
 */
export function parseDiff(input: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  let file: FileDiff | null = null;
  let status: FileStatus = "modified";

  const finish = () => {
    if (!file) return;
    if (file.oldPath === "/dev/null") file.status = "added";
    else if (file.newPath === "/dev/null") file.status = "deleted";
    else if (status === "renamed" || (file.oldPath && file.oldPath !== file.newPath)) file.status = "renamed";
    else file.status = status;
    file.path = file.status === "deleted" ? file.oldPath : file.newPath;
    files.push(file);
    file = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (raw.startsWith("diff --git ")) {
      finish();
      const q = raw.match(/^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
      const m = q ?? raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = q ? emptyFile(stripPrefix(q[1]), stripPrefix(q[2])) : emptyFile(m?.[1] ?? "", m?.[2] ?? "");
      status = "modified";
      continue;
    }
    // Plain `diff -u` file header (no "diff --git" line before it).
    if (raw.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") && (!file || file.hunks.length > 0)) {
      finish();
      file = emptyFile("", "");
      status = "modified";
    }
    if (!file) continue;

    if (raw.startsWith("new file mode")) { status = "added"; continue; }
    if (raw.startsWith("deleted file mode")) { status = "deleted"; continue; }
    if (raw.startsWith("rename from ")) { file.oldPath = unquotePath(raw.slice(12)); status = "renamed"; continue; }
    if (raw.startsWith("rename to ")) { file.newPath = unquotePath(raw.slice(10)); status = "renamed"; continue; }
    if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) { file.binary = true; continue; }
    if (raw.startsWith("--- ")) { file.oldPath = stripPrefix(raw.slice(4).split("\t")[0]); continue; }
    if (raw.startsWith("+++ ")) { file.newPath = stripPrefix(raw.slice(4).split("\t")[0]); continue; }

    const hm = raw.match(HUNK_RE);
    if (!hm) continue;

    let oldNo = Number(hm[1]);
    let newNo = Number(hm[3]);
    let oldLeft = hm[2] === undefined ? 1 : Number(hm[2]);
    let newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
    const hunk: Hunk = { header: raw, oldStart: oldNo, newStart: newNo, section: hm[5] ?? "", lines: [] };
    file.hunks.push(hunk);

    while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
      const body = lines[++i];
      const ch = body[0];
      let line: DiffLine | null = null;
      if (ch === "+") {
        line = { kind: "add", text: body.slice(1), oldNo: null, newNo: newNo++, risks: [] };
        file.additions++;
        newLeft--;
      } else if (ch === "-") {
        line = { kind: "del", text: body.slice(1), oldNo: oldNo++, newNo: null, risks: [] };
        file.deletions++;
        oldLeft--;
      } else if (ch === " " || body === "") {
        line = { kind: "ctx", text: body.slice(1), oldNo: oldNo++, newNo: newNo++, risks: [] };
        oldLeft--;
        newLeft--;
      } else if (ch === "\\") {
        continue; // "\ No newline at end of file"
      } else {
        i--; // malformed hunk: hand the line back to the outer loop
        break;
      }
      hunk.lines.push(line);
    }
    // Swallow a trailing "\ No newline" marker after the last counted line.
    if (lines[i + 1]?.startsWith("\\")) i++;
  }
  finish();
  return files.filter((f) => f.path && f.path !== "/dev/null");
}
