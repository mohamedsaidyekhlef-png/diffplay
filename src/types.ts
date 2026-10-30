export type LineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** Risk flags attached to this line by the risk engine. */
  risks: RiskHit[];
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  section: string;
  lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface FileDiff {
  oldPath: string;
  newPath: string;
  path: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  layer: Layer;
  /** Highest severity across this file (0 = none). */
  riskScore: number;
  fileRisks: RiskHit[];
}

export type Layer =
  | "deps"
  | "config"
  | "schema"
  | "types"
  | "core"
  | "api"
  | "ui"
  | "tests"
  | "docs"
  | "generated";

export type Severity = "high" | "medium" | "low";

export interface RiskHit {
  rule: string;
  label: string;
  severity: Severity;
  why: string;
}

export interface Step {
  id: number;
  layer: Layer;
  title: string;
  /** One-sentence plain-English explanation of why this step exists. */
  narration: string;
  files: FileDiff[];
  risk: Severity | "none";
}

export interface Walkthrough {
  title: string;
  summary: string;
  source: string;
  generatedAt: string;
  narratedBy: string;
  stats: {
    files: number;
    additions: number;
    deletions: number;
    hidden: number;
    risks: { high: number; medium: number; low: number };
    /** Percent of changed lines a reviewer actually needs to read closely. */
    focusPercent: number;
  };
  steps: Step[];
  hiddenFiles: FileDiff[];
  topRisks: { file: string; line: number | null; hit: RiskHit; text: string }[];
}
