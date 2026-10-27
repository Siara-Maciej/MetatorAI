<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

/**
 * A system of applications in several repositories, grouped into deploy waves (providers first),
 * with the contracts between them. The animation plays what `system show` and the planned
 * `system impact` answer: a contract changes, its consumers light up, deploys go wave by wave.
 */
interface App {
  id: string;
  kind: string;
  repo: string;
}
interface Contract {
  id: string;
  owner: string;
  consumers: string[];
}

const apps: App[] = [
  { id: "orders", kind: "service", repo: "shop/orders" },
  { id: "billing", kind: "service", repo: "shop/platform · services/billing" },
  { id: "gateway", kind: "gateway", repo: "shop/platform · apps/gateway" },
  { id: "mailer", kind: "worker", repo: "shop/mailer" },
  { id: "web", kind: "frontend", repo: "shop/web" },
];
const contracts: Contract[] = [
  { id: "orders-api", owner: "orders", consumers: ["gateway", "mailer"] },
  { id: "billing-api", owner: "billing", consumers: ["gateway"] },
  { id: "gateway-api", owner: "gateway", consumers: ["web"] },
];
const waves = [["orders", "billing"], ["gateway", "mailer"], ["web"]];

const W = 900;
const COL = 320;
const pos = new Map<string, { x: number; y: number }>();
for (const [c, wave] of waves.entries())
  for (const [r, id] of wave.entries())
    pos.set(id, { x: 30 + c * COL, y: 70 + r * 120 + (wave.length === 1 ? 60 : 0) });
/** One label per contract, where it leaves its provider. */
const labels = contracts.map((k) => {
  const a = pos.get(k.owner) as { x: number; y: number };
  return { id: k.id, x: a.x + 204, y: a.y + 24 };
});
const edges = contracts.flatMap((k) =>
  k.consumers.map((to) => {
    const a = pos.get(k.owner) as { x: number; y: number };
    const b = pos.get(to) as { x: number; y: number };
    const x1 = a.x + 200;
    const y1 = a.y + 34;
    const x2 = b.x;
    const y2 = b.y + 34;
    return {
      id: `${k.id}:${to}`,
      contract: k.id,
      from: k.owner,
      to,
      path: `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`,
    };
  }),
);

/** 0 idle · 1 orders-api changes · 2 consumers are impacted · 3..5 deploy wave 1..3 */
const step = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    step.value = 2;
    return;
  }
  timer = setInterval(() => (step.value = (step.value + 1) % 6), 1500);
});
onBeforeUnmount(() => timer && clearInterval(timer));

const changed = "orders-api";
const impacted = computed(() =>
  step.value >= 2 ? (contracts.find((c) => c.id === changed)?.consumers ?? []) : [],
);
const deployed = computed(() => new Set(waves.slice(0, Math.max(0, step.value - 2)).flat()));
const caption = computed(
  () =>
    [
      "A system of five applications in four repositories",
      "orders changes the orders-api contract (OpenAPI)",
      "system impact: gateway and mailer consume it; owners are notified",
      "wave 1 deploys: providers first (orders, billing)",
      "wave 2 deploys: gateway and mailer",
      "wave 3 deploys: web",
    ][step.value],
);
</script>

<template>
  <section class="mx-panel mx-sys" aria-label="System of applications and contracts">
    <p class="mx-eyebrow">system map · contracts · deploy waves</p>
    <div class="mx-sys-scroll">
      <svg :viewBox="`0 0 ${W} 330`" role="img" aria-label="Applications grouped in deploy waves with contracts between them">
        <g v-for="(wave, i) in waves" :key="i">
          <rect :x="15 + i * COL" y="18" width="230" height="300" rx="14" class="wave" :class="{ on: step - 3 === i }" />
          <text :x="130 + i * COL" y="44" text-anchor="middle" class="wave-label">wave {{ i + 1 }}</text>
        </g>
        <path v-for="e in edges" :key="e.id" :d="e.path" class="edge" :class="{ hot: step >= 1 && e.contract === changed }" />
        <text v-for="l in labels" :key="l.id" :x="l.x" :y="l.y" class="edge-label" :class="{ hot: step >= 1 && l.id === changed }">
          {{ l.id }}
        </text>
        <g
          v-for="a in apps"
          :key="a.id"
          class="app"
          :class="{
            changed: step >= 1 && a.id === 'orders',
            impacted: impacted.includes(a.id),
            deployed: deployed.has(a.id),
          }"
          :transform="`translate(${pos.get(a.id)?.x},${pos.get(a.id)?.y})`"
        >
          <rect width="200" height="68" rx="12" />
          <text x="14" y="26" class="app-id">{{ a.id }}</text>
          <text x="14" y="44" class="app-kind">{{ a.kind }}</text>
          <text x="14" y="59" class="app-repo">{{ a.repo }}</text>
          <circle cx="182" cy="18" r="5" class="dot" />
        </g>
      </svg>
    </div>
    <p class="mx-sys-caption" aria-live="polite">{{ caption }}</p>
    <div class="mx-legend">
      <span class="mx-chip gold">changed contract</span>
      <span class="mx-chip violet">impacted consumer</span>
      <span class="mx-chip teal">deployed</span>
    </div>
  </section>
</template>

<style scoped>
.mx-sys-scroll {
  overflow-x: auto;
}
svg {
  min-width: 560px;
  width: 100%;
  height: auto;
  display: block;
}
.wave {
  fill: var(--mx-panel-2);
  stroke: var(--mx-line);
  stroke-dasharray: 5 5;
  transition: stroke 0.4s ease;
}
.wave.on {
  stroke: var(--mx-teal);
  stroke-dasharray: none;
}
.wave-label {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  fill: var(--mx-gold);
}
.edge {
  fill: none;
  stroke: var(--mx-muted);
  stroke-width: 1.5;
  stroke-dasharray: 5 6;
  opacity: 0.6;
  animation: mx-dash 1.4s linear infinite;
}
.edge.hot {
  stroke: var(--mx-gold);
  stroke-width: 2.4;
  opacity: 1;
}
@keyframes mx-dash {
  to {
    stroke-dashoffset: -22;
  }
}
.edge-label {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  fill: var(--mx-muted);
}
.edge-label.hot {
  fill: var(--mx-gold);
  font-weight: 600;
}
.app rect {
  fill: var(--mx-panel);
  stroke: var(--mx-line);
  stroke-width: 1.5;
  transition: stroke 0.4s ease, fill 0.4s ease;
}
.app.changed rect {
  stroke: var(--mx-gold);
}
.app.impacted rect {
  stroke: var(--mx-violet);
  fill: var(--mx-violet-soft);
}
.app.deployed rect {
  stroke: var(--mx-teal);
}
.app .dot {
  fill: var(--mx-line);
  transition: fill 0.4s ease;
}
.app.changed .dot {
  fill: var(--mx-gold);
}
.app.impacted .dot {
  fill: var(--mx-violet);
}
.app.deployed .dot {
  fill: var(--mx-teal);
}
.app-id {
  font-family: var(--vp-font-family-mono);
  font-size: 15px;
  font-weight: 600;
  fill: var(--mx-ink);
}
.app-kind,
.app-repo {
  font-size: 11.5px;
  fill: var(--mx-muted);
}
.mx-sys-caption {
  min-height: 1.6em;
  margin: 10px 0 0 !important;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--mx-ink);
}
</style>
