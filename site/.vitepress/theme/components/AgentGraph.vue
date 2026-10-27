<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { data } from "../../data/agents.data.ts";

/**
 * Who may start whom, from the canonical agents: one band per coordinator with the workers it
 * delegates to. A pulse runs down the trunk and lights the workers one by one, as a run does.
 */
const coordinators = computed(() => data.agents.filter((a) => a.role === "coordinator"));
const bands = computed(() => {
  const seen = new Set<string>();
  return coordinators.value.map((c) => {
    const workers = c.delegates
      .filter((d) => data.agents.some((a) => a.id === d && a.role === "worker"))
      .map((d) => ({ id: d, shared: seen.has(d) }));
    for (const w of workers) seen.add(w.id);
    const hands = c.delegates.filter((d) => coordinators.value.some((o) => o.id === d));
    return { coordinator: c, workers, hands };
  });
});

const tick = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  timer = setInterval(() => tick.value++, 700);
});
onBeforeUnmount(() => timer && clearInterval(timer));
const litIndex = (n: number) => (n === 0 ? -1 : tick.value % (n + 3));
</script>

<template>
  <section class="mx-panel mx-graph" aria-label="Agent delegation">
    <p class="mx-eyebrow">
      delegation · {{ coordinators.length }} coordinators · {{ data.agents.length - coordinators.length }} workers
    </p>
    <div v-for="(b, bi) in bands" :key="b.coordinator.id" class="mx-band">
      <div class="mx-coord">
        <code>{{ b.coordinator.id }}</code>
        <span>{{ b.coordinator.tier }} · coordinator</span>
        <span v-for="h in b.hands" :key="h" class="mx-hand">hands the review to <code>{{ h }}</code> ↓</span>
      </div>
      <div class="mx-trunk" aria-hidden="true"><i :style="{ animationDelay: `${bi * 0.6}s` }"></i></div>
      <div class="mx-workers">
        <div
          v-for="(w, i) in b.workers"
          :key="w.id"
          class="mx-worker"
          :class="{ lit: litIndex(b.workers.length) === i, shared: w.shared }"
          :data-agent="w.id"
        >
          <code>{{ w.id }}</code>
          <span v-if="w.shared" class="mx-shared">also above</span>
        </div>
      </div>
    </div>
    <div class="mx-legend">
      <span class="mx-chip gold">coordinator: follows a workflow, never edits code</span>
      <span class="mx-chip teal">worker: one stage, one artifact, least privilege</span>
    </div>
  </section>
</template>

<style scoped>
.mx-band {
  display: grid;
  grid-template-columns: 220px 60px 1fr;
  align-items: center;
  margin: 14px 0;
}
@media (max-width: 760px) {
  .mx-band {
    grid-template-columns: 1fr;
  }
  .mx-trunk {
    display: none;
  }
}
.mx-coord {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--mx-gold);
  background: var(--mx-gold-soft);
}
.mx-coord code {
  font-size: 14px;
  font-weight: 700;
  background: none !important;
  padding: 0 !important;
}
.mx-coord span {
  font-size: 12px;
  color: var(--mx-muted);
}
.mx-hand code {
  font-size: 12px !important;
  font-weight: 500 !important;
}
.mx-trunk {
  position: relative;
  height: 2px;
  background: repeating-linear-gradient(90deg, var(--mx-teal) 0 6px, transparent 6px 11px);
  opacity: 0.8;
}
.mx-trunk i {
  position: absolute;
  top: -4px;
  left: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--mx-teal);
  box-shadow: 0 0 12px var(--mx-teal);
  animation: mx-run 1.4s ease-in-out infinite;
}
@keyframes mx-run {
  from {
    left: 0;
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  to {
    left: 52px;
    opacity: 0;
  }
}
.mx-workers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
  padding: 12px;
  border-radius: 14px;
  border: 1px dashed var(--mx-line);
}
.mx-worker {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel-2);
  transition: border-color 0.35s ease, box-shadow 0.35s ease, background 0.35s ease;
}
.mx-worker code {
  font-size: 12.5px;
  background: none !important;
  padding: 0 !important;
}
.mx-worker.lit {
  border-color: var(--mx-teal);
  background: var(--mx-teal-soft);
  box-shadow: var(--mx-glow);
}
.mx-shared {
  font-size: 10.5px;
  color: var(--mx-muted);
}
</style>
