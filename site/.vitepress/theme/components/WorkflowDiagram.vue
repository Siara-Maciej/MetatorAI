<script setup lang="ts">
import { computed } from "vue";
import { data, type StageView } from "../../data/workflows.data.ts";

/** A shipped workflow as a table of its stages, read from the spec the CLI runs. */
const props = defineProps<{ id: string }>();
const workflow = computed(() => {
  const w = data[props.id];
  if (!w) throw new Error(`unknown workflow ${props.id}`);
  return w;
});
const who = (s: StageView) =>
  s.hitl ? "you" : [...s.owners.map((o) => o.replace(/^(skill|script):/, "")), ...s.parallel].join(", ");
const check = (s: StageView) =>
  s.hitl ? "your approval" : (s.gate?.script ?? (s.gate?.llm ? `critic ${s.gate.llm}` : ""));
const loops = computed(() =>
  workflow.value.stages
    .filter((s) => s.onFail)
    .map((s) => ({ from: s.id, ...(s.onFail as NonNullable<StageView["onFail"]>) })),
);
</script>

<template>
  <section class="mx-wf" :aria-label="`Workflow ${workflow.id}`">
    <div class="mx-wf-scroll">
      <table>
        <caption>
          <code>{{ workflow.id }}</code>
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Stage</th>
            <th scope="col">Done by</th>
            <th scope="col">Leaves</th>
            <th scope="col">Passes when</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(stage, i) in workflow.stages" :key="stage.id" :data-stage="stage.id" :class="{ human: stage.hitl }">
            <td>{{ i + 1 }}</td>
            <td>
              <code>{{ stage.id }}</code>
              <span v-if="stage.optional" class="mx-wf-note"> optional</span>
            </td>
            <td>{{ who(stage) }}</td>
            <td>{{ stage.produces.join(", ") }}</td>
            <td>
              <code v-if="check(stage) && !stage.hitl">{{ check(stage) }}</code>
              <template v-else>{{ check(stage) }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-for="l in loops" :key="l.from" class="mx-wf-loop">
      If <code>{{ l.from }}</code> fails, the run goes back to <code>{{ l.goto }}</code>, at most {{ l.limit }}
      {{ l.limit === 1 ? "time" : "times" }}. After that it stops and asks you.
    </p>
  </section>
</template>

<style scoped>
.mx-wf {
  margin: 20px 0;
}
.mx-wf-scroll {
  overflow-x: auto;
}
.mx-wf table {
  margin: 0;
  font-size: 14px;
}
.mx-wf caption {
  text-align: left;
  padding: 0 0 8px;
  color: var(--vp-c-text-2);
}
.mx-wf tr.human td {
  background: var(--vp-c-brand-soft);
}
.mx-wf-note {
  color: var(--vp-c-text-2);
  font-size: 12px;
}
.mx-wf-loop {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--vp-c-text-2);
}
</style>
