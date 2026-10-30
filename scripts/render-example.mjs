// Renders the test-suite PR used for the README screenshots: node scripts/render-example.mjs out.html
import { readFileSync, writeFileSync } from "node:fs";
import { buildWalkthrough, renderHtml } from "../dist/index.js";

const key = ["sk", "live", "51NqAbCdEfGhIjKlMnOpQrStUv"].join("_");
const diff = readFileSync(new URL("../test/fixtures/agent-pr.diff", import.meta.url), "utf8").replaceAll("__FAKE_STRIPE_LIVE_KEY__", key);
const out = process.argv[2] ?? "example.html";
writeFileSync(out, renderHtml(buildWalkthrough(diff, { title: "Add per-seat team billing", source: "test/fixtures/agent-pr.diff" })));
console.log(`wrote ${out}`);
