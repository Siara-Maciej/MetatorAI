<script setup lang="ts">
import { withBase } from "vitepress";
import { data } from "../../data/commands.data.ts";

/** Every command group of the CLI with its commands, linking into the generated reference. */
const PURPOSE: Record<string, string> = {
  changed: "Survey",
  index: "Survey",
  graph: "Survey",
  workspace: "Survey",
  symbols: "Survey",
  api: "Survey",
  owners: "Survey",
  system: "Multi-repo",
  rules: "Canon",
  memory: "Knowledge",
  lessons: "Knowledge",
  docs: "Knowledge",
  cards: "Knowledge",
  patterns: "Canon",
  similar: "Canon",
  adr: "Canon",
  discover: "Setup",
  init: "Setup",
  config: "Setup",
  generate: "Setup",
  meta: "Canon",
  gate: "Quality",
  test: "Quality",
  coverage: "Quality",
  flaky: "Quality",
  "debug-tags": "Quality",
  plan: "Runs",
  run: "Runs",
  workflow: "Runs",
  findings: "Review",
  review: "Review",
  eval: "Review",
  guard: "Hooks",
};
const anchor = (name: string) => `metator-${name.replaceAll(" ", "-")}`;
const groups = data.filter((g) => !["version", "help"].includes(g.group));
</script>

<template>
  <div class="mx-cmds">
    <article v-for="g in groups" :key="g.group" class="mx-cmd">
      <header>
        <code>metator {{ g.group }}</code>
        <span class="mx-chip">{{ PURPOSE[g.group] ?? "Other" }}</span>
      </header>
      <ul>
        <li v-for="c in g.commands" :key="c.name">
          <a :href="withBase(`/api/commands#${anchor(c.name)}`)">{{ c.name }}</a>
          <span>{{ c.summary }}</span>
        </li>
      </ul>
    </article>
  </div>
</template>

<style scoped>
.mx-cmds {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  align-items: start;
  gap: 14px;
  margin: 20px 0;
}
.mx-cmd {
  border: 1px solid var(--mx-line);
  border-radius: 12px;
  padding: 14px;
  background: var(--mx-panel);
}
.mx-cmd header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.mx-cmd header code {
  font-weight: 600;
}
ul {
  list-style: none;
  padding: 0 !important;
  margin: 0 !important;
}
li {
  margin: 6px 0 !important;
  font-size: 13px;
  line-height: 1.4;
}
li a {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  margin-right: 6px;
}
li span {
  color: var(--mx-muted);
}
</style>
