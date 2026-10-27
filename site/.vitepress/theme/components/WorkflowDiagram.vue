<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { data, type StageView } from "../../data/workflows.data.ts";

/** A shipped workflow, drawn from its spec; a run token walks the stages like `metator run advance`. */
const props = defineProps<{ id: string }>();
const workflow = computed(() => {
  const w = data[props.id];
  if (!w) throw new Error(`unknown workflow ${props.id}`);
  return w;
});

const active = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  timer = setInterval(() => {
    active.value = (active.value + 1) % workflow.value.stages.length;
  }, 1400);
});
onBeforeUnmount(() => timer && clearInterval(timer));

type Owner = { name: string; type: "agent" | "skill" | "script" };
const owner = (o: string): Owner =>
  o.startsWith("skill:")
    ? { name: o.slice(6), type: "skill" }
    : o.startsWith("script:")
      ? { name: o.slice(7), type: "script" }
      : { name: o, type: "agent" };
const owners = (s: StageView) => s.owners.map(owner);
const loops = computed(() =>
  workflow.value.stages
    .filter((s) => s.onFail)
    .map((s) => ({ from: s.id, ...(s.onFail as NonNullable<StageView["onFail"]>) })),
);
const kind = (s: StageView) =>
  s.hitl ? "human" : s.parallel.length > 0 ? "parallel" : s.gate ? "gate" : "work";
</script>

<template>
  <section class="mx-panel mx-wf" :aria-label="`Workflow ${workflow.id}`">
    <header class="mx-wf-head">
      <div>
        <p class="mx-eyebrow">workflow · {{ workflow.stages.length }} stages</p>
        <h3 class="mx-wf-title">{{ workflow.id }}</h3>
        <p class="mx-wf-desc">{{ workflow.description }}</p>
      </div>
      <div class="mx-wf-autonomy">
        <span v-for="level in workflow.autonomy" :key="level" class="mx-chip">{{ level }}</span>
      </div>
    </header>

    <ol class="mx-wf-track">
      <li
        v-for="(stage, i) in workflow.stages"
        :key="stage.id"
        class="mx-wf-stage"
        :class="[kind(stage), { active: i === active, done: i < active, optional: stage.optional }]"
        :data-stage="stage.id"
      >
        <div class="mx-wf-top">
          <span class="mx-wf-index">{{ String(i + 1).padStart(2, "0") }}</span>
          <span v-if="stage.hitl" class="mx-wf-badge gold">{{ stage.neverSkip ? "🔒 human, always" : "✋ human gate" }}</span>
          <span v-else-if="stage.parallel.length" class="mx-wf-badge violet">∥ parallel</span>
          <span v-else-if="stage.gate" class="mx-wf-badge teal">🛡 gate</span>
        </div>
        <strong class="mx-wf-name">{{ stage.id }}</strong>
        <p v-if="stage.description" class="mx-wf-text">{{ stage.description }}</p>
        <div class="mx-wf-chips">
          <span v-for="o in owners(stage)" :key="o.name" class="mx-chip" :class="{ teal: o.type === 'agent', violet: o.type === 'skill' }">
            {{ o.type === "script" ? "›_ " : o.type === "skill" ? "◆ " : "" }}{{ o.name }}
          </span>
          <span v-for="p in stage.parallel" :key="p" class="mx-chip violet">{{ p }}</span>
        </div>
        <div v-if="stage.gate" class="mx-wf-gate">
          <span v-if="stage.gate.script">script: <code>{{ stage.gate.script }}</code></span>
          <span v-if="stage.gate.llm">critic: <code>{{ stage.gate.llm }}</code></span>
        </div>
        <div v-if="stage.produces.length" class="mx-wf-files">
          <span v-for="f in stage.produces" :key="f">📄 {{ f }}</span>
        </div>
        <p v-if="stage.skipAt.length" class="mx-wf-skip">skipped at {{ stage.skipAt.join(", ") }}</p>
        <span v-if="i < workflow.stages.length - 1" class="mx-wf-link" aria-hidden="true"></span>
      </li>
    </ol>

    <div v-if="loops.length" class="mx-wf-loops">
      <p class="mx-eyebrow">bounded loops</p>
      <div v-for="l in loops" :key="l.from" class="mx-wf-loop">
        <span class="mx-chip">{{ l.from }}</span>
        <span class="mx-wf-arrow" aria-hidden="true"><i></i></span>
        <span class="mx-chip gold">{{ l.goto }}</span>
        <span class="mx-wf-limit">on FAIL · loop <code>{{ l.loop }}</code> · at most {{ l.limit }}×, then escalate</span>
      </div>
    </div>

    <div v-if="workflow.done.length" class="mx-wf-done">
      <p class="mx-eyebrow">definition of done</p>
      <ul>
        <li v-for="d in workflow.done" :key="d">✓ {{ d }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.mx-wf-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  align-items: flex-start;
  margin-bottom: 18px;
}
.mx-wf-title {
  margin: 0 !important;
  border: 0 !important;
  padding: 0 !important;
  font-family: var(--vp-font-family-mono);
  font-size: 20px;
}
.mx-wf-desc {
  margin: 4px 0 0 !important;
  color: var(--mx-muted);
}
.mx-wf-autonomy {
  display: flex;
  gap: 6px;
}
.mx-wf-track {
  container-type: inline-size;
  list-style: none;
  padding: 0 !important;
  margin: 0 !important;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 18px;
}
.mx-wf-stage {
  position: relative;
  margin: 0 !important;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel-2);
  transition: border-color 0.4s ease, box-shadow 0.4s ease, transform 0.4s ease;
}
.mx-wf-stage.optional {
  border-style: dashed;
}
.mx-wf-stage.human {
  border-color: color-mix(in srgb, var(--mx-gold) 55%, var(--mx-line));
}
.mx-wf-stage.done {
  opacity: 0.85;
}
.mx-wf-stage.active {
  border-color: var(--mx-teal);
  box-shadow: var(--mx-glow);
  transform: translateY(-2px);
}
.mx-wf-stage.human.active {
  border-color: var(--mx-gold);
  box-shadow: 0 0 0 1px rgba(240, 180, 41, 0.45), 0 8px 28px rgba(240, 180, 41, 0.2);
}
.mx-wf-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.mx-wf-index {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--mx-gold);
}
.mx-wf-stage.done .mx-wf-index::after {
  content: " ✓";
  color: var(--mx-green);
}
.mx-wf-badge {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
}
.mx-wf-badge.gold {
  background: var(--mx-gold-soft);
  color: var(--mx-gold);
}
.mx-wf-badge.violet {
  background: var(--mx-violet-soft);
  color: var(--mx-violet);
}
.mx-wf-badge.teal {
  background: var(--mx-teal-soft);
  color: var(--mx-teal);
}
.mx-wf-name {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 15px;
}
.mx-wf-text {
  margin: 4px 0 8px !important;
  font-size: 13px;
  line-height: 1.45;
  color: var(--mx-muted);
}
.mx-wf-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.mx-wf-chips .mx-chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mx-wf-gate,
.mx-wf-files {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--mx-muted);
}
.mx-wf-skip {
  margin: 8px 0 0 !important;
  font-size: 12px;
  color: var(--mx-gold);
}
/* Connector to the next card, with dashes flowing towards it. */
.mx-wf-link {
  position: absolute;
  top: 26px;
  right: -18px;
  width: 18px;
  height: 2px;
  background: repeating-linear-gradient(90deg, var(--mx-teal) 0 5px, transparent 5px 9px);
  background-size: 18px 2px;
  animation: mx-flow 0.8s linear infinite;
  opacity: 0.8;
}
@media (max-width: 640px) {
  .mx-wf-link {
    display: none;
  }
}
@keyframes mx-flow {
  from {
    background-position: 0 0;
  }
  to {
    background-position: 18px 0;
  }
}
.mx-wf-loops,
.mx-wf-done {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px dashed var(--mx-line);
}
.mx-wf-loop {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 6px 0;
}
.mx-wf-arrow {
  position: relative;
  width: 70px;
  height: 14px;
  border-bottom: 2px dashed var(--mx-violet);
  border-radius: 0 0 40px 40px;
}
.mx-wf-arrow i {
  position: absolute;
  bottom: -5px;
  left: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--mx-violet);
  animation: mx-back 1.6s ease-in-out infinite;
}
@keyframes mx-back {
  from {
    left: 62px;
  }
  to {
    left: 0;
  }
}
.mx-wf-limit {
  font-size: 13px;
  color: var(--mx-muted);
}
.mx-wf-done ul {
  list-style: none;
  padding: 0 !important;
  margin: 0 !important;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  font-size: 14px;
}
.mx-wf-done li {
  margin: 0 !important;
}
</style>
