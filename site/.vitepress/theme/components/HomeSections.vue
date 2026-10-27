<script setup lang="ts">
import { withBase } from "vitepress";
import flowUrl from "../../../../assets/flow.svg";
import reviewUrl from "../../../../assets/review.svg";
import { data as agents } from "../../data/agents.data.ts";
import { data as commands } from "../../data/commands.data.ts";
import { data as workflows } from "../../data/workflows.data.ts";
import AgentGraph from "./AgentGraph.vue";
import PrincipleFlow from "./PrincipleFlow.vue";
import SystemDiagram from "./SystemDiagram.vue";
import TerminalDemo from "./TerminalDemo.vue";
import WorkflowDiagram from "./WorkflowDiagram.vue";

/** The landing page below the hero. Every number is read from the shipped canon, not typed in. */
const stats = [
  { value: agents.agents.length, label: "agents" },
  { value: agents.skills.length, label: "skills" },
  { value: Object.keys(workflows).length, label: "workflows" },
  { value: commands.reduce((n, g) => n + g.commands.length, 0), label: "CLI commands" },
  { value: 2, label: "AI hosts" },
];

const problems = [
  [
    "Agents guess the codebase",
    "Measured facts: import graph, affected tests, module cards, owners, the exemplar to copy.",
  ],
  [
    "Rules live in a wiki",
    "A rule canon in the repo, delivered per file and enforced by ast-grep, Biome, tsc and tests.",
  ],
  [
    "Plans skip tests and reinvent",
    "`plan lint` rejects new files without an exemplar or an ADR, and code before its tests.",
  ],
  [
    "Review comments without proof",
    "Findings quote the code, a verifier tries to refute each one, only confirmed blockers block.",
  ],
  ["Agents act on their own", "Hooks deny edits outside the plan and pushes without a human approval."],
  ["Context is lost", "Every run lives on disk with an audit trail and resumes in any session or CI job."],
];

const enterprise = [
  [
    "📜",
    "Audit trail",
    "Every transition, approval and checkpoint is appended to the run's log.md; state.json changes only through `metator run`.",
  ],
  [
    "✋",
    "Human approvals",
    "Plan, push and PR comments wait for `metator run approve`. Gates marked neverSkip cannot be automated away.",
  ],
  [
    "🔐",
    "Least privilege",
    "Each agent gets only the CLI groups it needs; coordinators never edit code; secrets are never read.",
  ],
  [
    "🧾",
    "Versioned files",
    "Every file carries kind and schemaVersion, with frozen schemas and migrations on read.",
  ],
  [
    "🚦",
    "Gates in CI",
    "`metator gate full` and `metator meta check-all` run the same checks agents run, with one JSON report.",
  ],
  [
    "📏",
    "Measured review",
    "Precision and recall on a golden set; `eval compare` fails CI when a prompt change makes review worse.",
  ],
  [
    "🎛️",
    "One canon, two hosts",
    "Agents, skills, rules and hooks generated for GitHub Copilot and Claude Code from one source.",
  ],
  [
    "🧩",
    "Ports and adapters",
    "Tools are plugins behind small ports; every adapter passes a contract suite.",
  ],
];
</script>

<template>
  <div class="mx-home">
    <section class="mx-stats" aria-label="In numbers">
      <div v-for="s in stats" :key="s.label">
        <strong>{{ s.value }}</strong>
        <span>{{ s.label }}</span>
      </div>
    </section>

    <section class="mx-section">
      <p class="mx-eyebrow">the idea</p>
      <h2>The metator marched ahead of the legion and staked out the camp.</h2>
      <p class="mx-lead">
        MetatorAI does that for AI agents on your code. Before a line changes, it measures the terrain and marks out
        the lines every change must follow. Then it puts gates on those lines that no agent can skip.
      </p>
      <div class="mx-problems">
        <article v-for="[p, s] in problems" :key="p">
          <span class="bad">✕ {{ p }}</span>
          <span class="good">✓ <span v-html="s.replace(/`([^`]+)`/g, '<code>$1</code>')"></span></span>
        </article>
      </div>
      <a class="mx-more" :href="withBase('/product/idea')">Read the idea →</a>
    </section>

    <section class="mx-section">
      <p class="mx-eyebrow">how it works</p>
      <h2>LLMs decide. Scripts measure. Hooks enforce. Humans approve.</h2>
      <PrincipleFlow />
      <div class="mx-art-wrap">
        <img class="mx-art" :src="flowUrl" alt="The Metator loop: survey, plan, gate, build, verify, ship, with a bounded loop back to the plan" />
      </div>
      <a class="mx-more" :href="withBase('/product/how-it-works')">How it works in detail →</a>
    </section>

    <section class="mx-section">
      <p class="mx-eyebrow">workflows as state machines</p>
      <h2>Every stage has an owner, an artifact and a gate.</h2>
      <p class="mx-lead">This is the shipped feature workflow, drawn from its spec. The token moves the way <code>metator run advance</code> does.</p>
      <WorkflowDiagram id="mt-feature" />
      <a class="mx-more" :href="withBase('/workflows/')">All workflows →</a>
    </section>

    <section class="mx-section mx-split">
      <div>
        <p class="mx-eyebrow">see it work</p>
        <h2>One JSON answer per command.</h2>
        <p class="mx-lead">
          Agents call the CLI for every fact and every check. Each answer is one JSON envelope with a stable error code
          and a hint for the next step, so nothing depends on parsing prose.
        </p>
        <ul class="mx-ticks">
          <li>The graph tells the agent which tests a change reaches.</li>
          <li>The plan gate rejects a new file that copies nothing.</li>
          <li>The rule check names the canon rule that was broken.</li>
          <li>The hook denies a push until a person approves it.</li>
        </ul>
        <a class="mx-more" :href="withBase('/guide/quick-start')">Try it in 15 minutes →</a>
      </div>
      <TerminalDemo />
    </section>

    <section class="mx-section">
      <p class="mx-eyebrow">agents</p>
      <h2>{{ agents.agents.length }} agents, each with one job and only the tools for it.</h2>
      <AgentGraph />
      <div class="mx-art-wrap">
        <img class="mx-art" :src="reviewUrl" alt="Review: the diff sharded by module, parallel lenses, a verifier refutes findings, a judge decides" />
      </div>
      <a class="mx-more" :href="withBase('/agents/')">Meet the agents →</a>
    </section>

    <section class="mx-section">
      <p class="mx-eyebrow">multi-repo</p>
      <h2>Changes across applications, in the right order.</h2>
      <p class="mx-lead">
        The system map says which applications provide and consume which contract. MetatorAI checks it in CI and
        computes the deploy waves, so a change ships providers first.
      </p>
      <SystemDiagram />
      <a class="mx-more" :href="withBase('/multi-repo/')">Systems of many applications →</a>
    </section>

    <section class="mx-section">
      <p class="mx-eyebrow">built for teams that need control</p>
      <h2>Governance is a script, not a promise.</h2>
      <div class="mx-ent">
        <article v-for="[icon, title, text] in enterprise" :key="title">
          <span class="icon">{{ icon }}</span>
          <h3>{{ title }}</h3>
          <p v-html="text.replace(/`([^`]+)`/g, '<code>$1</code>')"></p>
        </article>
      </div>
      <a class="mx-more" :href="withBase('/product/enterprise')">Security and governance →</a>
    </section>

    <section class="mx-cta">
      <h2>Lay out the ground. Then build.</h2>
      <p>Install from a checkout, survey your repository and run your first workflow.</p>
      <div>
        <a class="primary" :href="withBase('/guide/installation')">Get started</a>
        <a :href="withBase('/api/')">Explore the API</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mx-home {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px 80px;
}
.mx-stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin: 8px 0 56px;
}
@media (max-width: 760px) {
  .mx-stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
.mx-stats div {
  border: 1px solid var(--mx-line);
  border-radius: 12px;
  padding: 16px;
  text-align: center;
  background: var(--mx-panel);
}
.mx-stats strong {
  display: block;
  font-size: 32px;
  line-height: 1.1;
  background: linear-gradient(110deg, var(--mx-gold), var(--mx-teal));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.mx-stats span {
  font-size: 13px;
  color: var(--mx-muted);
}
.mx-section {
  margin: 72px 0;
}
.mx-home :deep(h2) {
  border-top: 0 !important;
  padding-top: 0 !important;
}
.mx-home a {
  text-decoration: none !important;
}
.mx-section h2,
.mx-cta h2 {
  font-size: 30px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 12px;
  max-width: 860px;
}
.mx-lead {
  font-size: 17px;
  line-height: 1.6;
  color: var(--mx-muted);
  max-width: 760px;
  margin: 0 0 18px;
}
.mx-more {
  display: inline-block;
  margin-top: 8px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}
.mx-art-wrap {
  overflow-x: auto;
}
.mx-art {
  min-width: 720px;
  width: 100%;
  border-radius: 14px;
  margin: 16px 0;
}
.mx-problems {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(330px, 1fr));
  gap: 12px;
  margin: 18px 0;
}
.mx-problems article {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel);
  font-size: 14px;
  line-height: 1.5;
}
.mx-problems .bad {
  color: var(--mx-red);
  font-weight: 600;
}
.mx-problems .good {
  color: var(--mx-ink);
}
.mx-split {
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: 32px;
  align-items: center;
}
@media (max-width: 900px) {
  .mx-split {
    grid-template-columns: 1fr;
  }
}
.mx-ticks {
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
}
.mx-ticks li {
  padding-left: 24px;
  position: relative;
  margin: 8px 0;
  font-size: 15px;
}
.mx-ticks li::before {
  content: "✓";
  position: absolute;
  left: 0;
  color: var(--mx-teal);
  font-weight: 700;
}
.mx-ent {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 14px;
  margin: 18px 0;
}
.mx-ent article {
  padding: 18px;
  border-radius: 12px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel);
  transition: border-color 0.25s ease, transform 0.25s ease;
}
.mx-ent article:hover {
  border-color: var(--mx-teal);
  transform: translateY(-2px);
}
.mx-ent .icon {
  font-size: 22px;
}
.mx-ent h3 {
  font-size: 16px;
  margin: 8px 0 6px;
}
.mx-ent p {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--mx-muted);
  margin: 0;
}
.mx-cta {
  margin-top: 80px;
  padding: 48px 32px;
  border-radius: 18px;
  text-align: center;
  border: 1px solid var(--mx-line);
  background: radial-gradient(circle at 20% 0%, var(--mx-teal-soft), transparent 55%),
    radial-gradient(circle at 80% 100%, var(--mx-gold-soft), transparent 55%), var(--mx-panel);
}
.mx-cta h2 {
  margin: 0 auto 10px;
}
.mx-cta p {
  color: var(--mx-muted);
  margin: 0 0 22px;
}
.mx-cta div {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
}
.mx-cta a {
  padding: 10px 22px;
  border-radius: 999px;
  font-weight: 600;
  border: 1px solid var(--mx-line);
  color: var(--mx-ink);
}
.mx-cta a.primary {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: #0d1117;
}
code {
  font-size: 0.9em;
}
</style>
