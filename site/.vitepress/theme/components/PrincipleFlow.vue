<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/** The principle of operation: who does what, as one change passes through the four roles. */
const roles = [
  {
    who: "LLMs decide",
    color: "violet",
    what: "Agents read the task and the measured facts, then propose: a plan, code, a review finding.",
    example: "mt-planner writes plan.json: S2 creates packages/billing/src/discount.ts",
  },
  {
    who: "Scripts measure",
    color: "teal",
    what: "The CLI checks every proposal deterministically and answers in one JSON envelope.",
    example: "metator plan lint → S2 needs an exemplar (patternSource) or an ADR",
  },
  {
    who: "Hooks enforce",
    color: "gold",
    what: "The AI host runs metator guard before and after each tool use; scope and approvals are not negotiable.",
    example: "guard pre-tool → deny: discount.ts is outside plan-scope.json",
  },
  {
    who: "Humans approve",
    color: "green",
    what: "People decide at the gates that matter: the plan, the push, the comments on a PR.",
    example: "metator run approve push --by alice",
  },
];

const active = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  timer = setInterval(() => (active.value = (active.value + 1) % roles.length), 2200);
});
onBeforeUnmount(() => timer && clearInterval(timer));
</script>

<template>
  <section class="mx-panel mx-principle" aria-label="Principle of operation">
    <p class="mx-eyebrow">principle of operation</p>
    <div class="mx-principle-grid">
      <article
        v-for="(r, i) in roles"
        :key="r.who"
        :class="[r.color, { on: i === active }]"
        @mouseenter="active = i"
      >
        <span class="step">{{ i + 1 }}</span>
        <h4>{{ r.who }}</h4>
        <p>{{ r.what }}</p>
        <code>{{ r.example }}</code>
        <span v-if="i < roles.length - 1" class="arrow" aria-hidden="true"></span>
      </article>
    </div>
    <div class="mx-principle-track" aria-hidden="true"><i :style="{ left: `${(active / (roles.length - 1)) * 100}%` }"></i></div>
  </section>
</template>

<style scoped>
.mx-principle-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 860px) {
  .mx-principle-grid {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 520px) {
  .mx-principle-grid {
    grid-template-columns: 1fr;
  }
}
article {
  position: relative;
  padding: 16px;
  border-radius: 12px;
  border: 1px solid var(--mx-line);
  background: var(--mx-panel-2);
  transition: border-color 0.35s ease, box-shadow 0.35s ease, transform 0.35s ease;
}
article.on {
  transform: translateY(-3px);
}
article.violet.on {
  border-color: var(--mx-violet);
  box-shadow: 0 8px 28px rgba(167, 139, 250, 0.2);
}
article.teal.on {
  border-color: var(--mx-teal);
  box-shadow: var(--mx-glow);
}
article.gold.on {
  border-color: var(--mx-gold);
  box-shadow: 0 8px 28px rgba(240, 180, 41, 0.2);
}
article.green.on {
  border-color: var(--mx-green);
  box-shadow: 0 8px 28px rgba(74, 222, 128, 0.18);
}
.step {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--mx-gold);
}
h4 {
  margin: 4px 0 6px !important;
  font-size: 17px;
}
p {
  font-size: 13px;
  line-height: 1.5;
  color: var(--mx-muted);
  margin: 0 0 10px !important;
}
code {
  display: block;
  overflow-wrap: anywhere;
  font-size: 11.5px;
  line-height: 1.45;
  white-space: normal;
}
.mx-principle-track {
  position: relative;
  height: 3px;
  margin: 18px 6% 2px;
  border-radius: 3px;
  background: var(--mx-line);
}
.mx-principle-track i {
  position: absolute;
  top: -4px;
  width: 11px;
  height: 11px;
  margin-left: -5px;
  border-radius: 50%;
  background: var(--mx-teal);
  box-shadow: 0 0 12px var(--mx-teal);
  transition: left 0.8s ease;
}
</style>
