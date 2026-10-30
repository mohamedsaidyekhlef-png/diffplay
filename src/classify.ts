import type { FileDiff, Layer } from "./types.js";

/** The order a human should read a change in. */
export const LAYER_ORDER: Layer[] = ["schema", "types", "config", "deps", "core", "api", "ui", "tests", "docs", "generated"];

export const LAYER_META: Record<Layer, { title: string; narration: string; icon: string }> = {
  schema: { title: "Data model & migrations", narration: "Start here: these change what is stored, so everything else depends on them.", icon: "◆" },
  types: { title: "Types & contracts", narration: "The shapes the rest of the change is written against.", icon: "◇" },
  config: { title: "Config, CI & infrastructure", narration: "Settings and pipelines that change how the code runs or ships.", icon: "⚙" },
  deps: { title: "Dependencies", narration: "New or changed packages: check every one is expected and trusted.", icon: "⬡" },
  core: { title: "Core logic", narration: "The behaviour change itself: read this part closely.", icon: "●" },
  api: { title: "API, routes & handlers", narration: "Where the outside world reaches the new logic: check inputs and auth.", icon: "⇄" },
  ui: { title: "User interface", narration: "What users will see and click.", icon: "▣" },
  tests: { title: "Tests", narration: "Does the change prove itself? Check the tests cover the risky parts above.", icon: "✓" },
  docs: { title: "Docs & comments", narration: "Explanations only: safe to skim.", icon: "¶" },
  generated: { title: "Generated & lock files", narration: "Machine-written: hidden by default.", icon: "⋯" },
};

const rules: [Layer, RegExp][] = [
  ["generated", /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|Pipfile\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor|__generated__|\.next)\/|\.snap$|\.pb\.go$|_pb2\.py$|\.generated\.\w+$/i],
  ["deps", /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json|Pipfile|build\.gradle(\.kts)?|pom\.xml)$/i],
  ["tests", /(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)\/|\.(test|spec)\.\w+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i],
  ["docs", /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|documentation)\//i],
  ["schema", /(^|\/)(migrations?|migrate|alembic|prisma|drizzle|schema|db\/schema)(\/|\.)|\.sql$|schema\.(prisma|graphql|gql|rb|ts|py)$|(^|\/)models?\//i],
  ["config", /(^|\/)(\.github|\.gitlab|\.circleci|terraform|infra|k8s|helm|deploy|docker)\/|Dockerfile|docker-compose|\.ya?ml$|\.toml$|\.ini$|\.env[^/]*$|(^|\/)\.[^/]+rc(\.\w+)?$|\.config\.(js|ts|mjs|cjs|json)$|(^|\/)(tsconfig|jsconfig|vercel|netlify|nx|turbo)\.json$|\.tf$|Makefile$/i],
  ["types", /\.d\.ts$|(^|\/)(types?|interfaces?|contracts?|dto)(\/|\.\w+$)|\.proto$/i],
  ["api", /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|resolvers?|server|middleware|trpc|graphql)(\/|\.\w+$)|(^|\/)route\.(ts|js)$|\.(controller|handler|router|resolver)\.\w+$|views\.py$|urls\.py$/i],
  ["ui", /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html|erb|hbs|ejs)$|(^|\/)(components?|pages|app|views|screens|ui|styles?|templates)\//i],
];

export function classify(file: FileDiff): Layer {
  const p = file.path;
  for (const [layer, re] of rules) if (re.test(p)) return layer;
  return "core";
}
