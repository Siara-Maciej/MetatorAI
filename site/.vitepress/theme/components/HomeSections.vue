<script setup lang="ts">
import { withBase } from "vitepress";
import flowUrl from "../../../../assets/flow.svg";
import { data as agents } from "../../data/agents.data.ts";
import { data as commands } from "../../data/commands.data.ts";
import { data as workflows } from "../../data/workflows.data.ts";
import TerminalDemo from "./TerminalDemo.vue";

/**
 * The landing page below the hero, in the order a reader decides: the loop, proof that it works,
 * a path for their role, the seven concepts, the modules, governance, and the way in. Every number
 * is read from the shipped canon, not typed in.
 */
const stats = [
  { value: agents.agents.length, label: "agents" },
  { value: agents.skills.length, label: "skills" },
  { value: Object.keys(workflows).length, label: "workflows" },
  { value: commands.reduce((n, g) => n + g.commands.length, 0), label: "CLI commands" },
  { value: 2, label: "AI hosts" },
];

const loop = [
  ["Survey", "graph, affected tests, patterns, the rules for exactly these files"],
  ["Plan", "every step names a file, the tests first and an exemplar `file:line`"],
  ["Gate", "`plan lint`, a critic on another model, then you"],
  ["Build", "tests red, then green; hooks block any edit outside the plan"],
  ["Verify", "review lenses in parallel; a verifier tries to refute every finding"],
  ["Ship", "the PR is drafted; nothing is pushed until a person says go"],
];

const paths = [
  {
    role: "Developer",
    title: "Run a feature with agents you can trust",
    text: "Start a run, answer its questions, watch a session when you want to see the terminal.",
    link: "/start/paths#i-write-code-with-agents",
    where: "Work → Feature, Sessions",
    accent: "var(--mx-teal)",
  },
  {
    role: "Platform owner",
    title: "Turn conventions into rules a tool enforces",
    text: "Write the canon once, generate agents for every host, put the gates in CI.",
    link: "/start/paths#i-own-the-platform",
    where: "Knowledge → Rules, Agents, Gates and CI",
    accent: "var(--mx-violet)",
  },
  {
    role: "Reviewer",
    title: "Get review comments that prove themselves",
    text: "Every finding carries a quote, a trigger and a path from a real caller; a verifier tries to refute it first.",
    link: "/start/paths#i-review-code",
    where: "Work → Review a PR",
    accent: "var(--mx-gold)",
  },
];

const concepts = [
  ["Run", "one task as a state machine, with an audit log on disk", "/concepts/run"],
  ["Workflow", "the YAML spec a run follows: stages, owners, gates, limits", "/concepts/workflow"],
  ["Gate and approvals", "checks and human gates no agent can talk past", "/concepts/gate"],
  ["Canon", "rules, patterns, module cards, ADRs, the memory map", "/concepts/canon"],
  ["Finding", "a review claim with evidence, verified before it blocks", "/concepts/finding"],
  ["Host", "Copilot and Claude Code: generated agents and hooks", "/concepts/host"],
  ["Session", "a worktree, a drive, the questions it asks you", "/concepts/session"],
];

const modules = [
  ["Systems of many applications", "/modules/systems"],
  ["Several repositories", "/modules/repositories"],
  ["Package architecture", "/modules/architecture"],
  ["Start the application", "/modules/environments"],
];

const governance = [
  "no edit outside the plan",
  "no push without a person's approval",
  "no secrets read, no destructive commands",
  "every run leaves log.md and state.json",
];

const code = (s: string) => s.replace(/`([^`]+)`/g, "<code>$1</code>");
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
      <p class="mx-eyebrow">the loop</p>
      <h2>Every stage leaves an artifact with a schema. A stage is done when it validates, not when the model says so.</h2>
      <ol class="mx-loop">
        <li v-for="[name, text] in loop" :key="name">
          <strong>{{ name }}</strong>
          <span v-html="code(text)"></span>
        </li>
      </ol>
      <div class="mx-art-wrap">
        <img class="mx-art" :src="flowUrl" alt="The Metator loop: survey, plan, gate, build, verify, ship, with a bounded loop back to the plan" />
      </div>
      <a class="mx-more" :href="withBase('/start/how-it-works')">How it works in detail →</a>
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
        <a class="mx-more" :href="withBase('/start/quick-start')">Try it in 15 minutes →</a>
      </div>
      <TerminalDemo />
    </section>

    <section class="mx-section">
      <p class="mx-eyebrow">choose your path</p>
      <h2>Three ways in, each a short read.</h2>
      <div class="mx-paths">
        <a v-for="p in paths" :key="p.role" :href="withBase(p.link)" :style="{ '--accent': p.accent }">
          <span class="role">{{ p.role }}</span>
          <strong>{{ p.title }}</strong>
          <p>{{ p.text }}</p>
          <span class="where">{{ p.where }}</span>
        </a>
      </div>
    </section>

    <section class="mx-section">
      <p class="mx-eyebrow">seven concepts</p>
      <h2>Everything else is built from these.</h2>
      <div class="mx-concepts">
        <a v-for="[name, text, link] in concepts" :key="name" :href="withBase(link)">
          <strong>{{ name }}</strong>
          <span>{{ text }}</span>
        </a>
        <div class="mx-concepts-note">
          Each concept page has the same shape: what, why, where on disk, commands, what enforces it, one JSON example.
        </div>
      </div>
    </section>

    <section class="mx-section">
      <div class="mx-modules">
        <span class="badge">Modules</span>
        <span class="mx-muted">Optional, for when the core is not enough:</span>
        <template v-for="([name, link], i) in modules" :key="name">
          <a :href="withBase(link)">{{ name }}</a><span v-if="i < modules.length - 1" class="dot">·</span>
        </template>
      </div>
    </section>

    <section class="mx-section mx-split mx-gov">
      <div>
        <p class="mx-eyebrow">built for teams that need control</p>
        <h2>Governance is a script, not a promise.</h2>
        <p class="mx-lead">
          Each rule is a hook you can read and test, with an audit trail per run. Push and PR comments wait for a named
          person at every autonomy level.
        </p>
        <a class="mx-more" :href="withBase('/reference/security')">Security and governance →</a>
      </div>
      <ul class="mx-gov-list">
        <li v-for="g in governance" :key="g">{{ g }}</li>
      </ul>
    </section>

    <section class="mx-cta">
      <h2>Lay out the ground. Then build.</h2>
      <p>Install from a checkout, survey your repository and run your first workflow in fifteen minutes.</p>
      <div>
        <a class="primary" :href="withBase('/start/installation')">Install</a>
        <a :href="withBase('/start/quick-start')">Quick start</a>
        <a :href="withBase('/reference/commands-people')">Commands</a>
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
  margin: 64px 0;
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
  font-size: 28px;
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
.mx-muted {
  color: var(--mx-muted);
}
.mx-more {
  display: inline-block;
  margin-top: 8px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}
.mx-loop {
  list-style: none;
  padding: 0;
  margin: 18px 0 8px;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  counter-reset: stage;
}
@media (max-width: 900px) {
  .mx-loop {
    grid-template-columns: repeat(2, 1fr);
  }
}
.mx-loop li {
  border: 1px solid var(--mx-line);
  border-radius: 12px;
  padding: 14px;
  background: var(--mx-panel);
  font-size: 13.5px;
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mx-loop li:nth-child(3) {
  border-color: var(--mx-teal);
}
.mx-loop strong {
  font-size: 15px;
}
.mx-loop span {
  color: var(--mx-muted);
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
.mx-paths {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 18px;
}
.mx-paths a {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 18px;
  border-radius: 12px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel);
  color: var(--mx-ink);
  transition: border-color 0.25s ease, transform 0.25s ease;
}
.mx-paths a:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
}
.mx-paths .role {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}
.mx-paths strong {
  font-size: 17px;
  line-height: 1.3;
}
.mx-paths p {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--mx-muted);
}
.mx-paths .where {
  margin-top: 4px;
  font-size: 13.5px;
  color: var(--vp-c-brand-1);
}
.mx-concepts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 10px;
  margin-top: 18px;
}
.mx-concepts a,
.mx-concepts-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel);
  color: var(--mx-ink);
  font-size: 13.5px;
  line-height: 1.5;
  transition: border-color 0.25s ease;
}
.mx-concepts a:hover {
  border-color: var(--mx-teal);
}
.mx-concepts strong {
  font-size: 15px;
}
.mx-concepts span {
  color: var(--mx-muted);
}
.mx-concepts-note {
  border-style: dashed;
  color: var(--mx-muted);
  justify-content: center;
}
.mx-modules {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-radius: 12px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel);
  font-size: 14px;
}
.mx-modules .badge {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--mx-line);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.mx-modules .dot {
  color: var(--mx-muted);
}
.mx-gov-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.mx-gov-list li {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel);
  font-size: 14px;
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
