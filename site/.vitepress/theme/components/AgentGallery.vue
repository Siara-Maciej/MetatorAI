<script setup lang="ts">
import { computed, ref } from "vue";
import { data } from "../../data/agents.data.ts";

/** Every canonical agent as a card: role, model tier, the CLI groups it may run, what it writes. */
const filter = ref<"all" | "coordinator" | "worker">("all");
const agents = computed(() => data.agents.filter((a) => filter.value === "all" || a.role === filter.value));
const groups = (caps: string[]) => caps.filter((c) => c.startsWith("metator:")).map((c) => c.slice(8));
const tools = (caps: string[]) => caps.filter((c) => !c.startsWith("metator:"));
</script>

<template>
  <section class="mx-gallery" aria-label="Agents">
    <div class="mx-gallery-filter" role="tablist">
      <button
        v-for="f in (['all', 'coordinator', 'worker'] as const)"
        :key="f"
        role="tab"
        :aria-selected="filter === f"
        :class="{ on: filter === f }"
        @click="filter = f"
      >
        {{ f === "all" ? `All (${data.agents.length})` : f === "coordinator" ? "Coordinators" : "Workers" }}
      </button>
    </div>
    <div class="mx-gallery-grid">
      <article v-for="a in agents" :key="a.id" class="mx-agent" :class="a.role" :data-agent="a.id">
        <header>
          <code class="mx-agent-id">{{ a.id }}</code>
          <span class="mx-chip" :class="a.role === 'coordinator' ? 'gold' : 'teal'">{{ a.role }}</span>
        </header>
        <p class="mx-agent-desc">{{ a.description }}</p>
        <dl>
          <div>
            <dt>tier</dt>
            <dd>{{ a.tier }}</dd>
          </div>
          <div v-if="groups(a.capabilities).length">
            <dt>may run</dt>
            <dd>
              <span v-for="g in groups(a.capabilities)" :key="g" class="mx-chip">metator {{ g }}</span>
            </dd>
          </div>
          <div>
            <dt>tools</dt>
            <dd>{{ tools(a.capabilities).join(" · ") }}</dd>
          </div>
          <div v-if="a.artifact">
            <dt>writes</dt>
            <dd>📄 {{ a.artifact }}</dd>
          </div>
          <div v-if="a.delegates.length">
            <dt>delegates to</dt>
            <dd>{{ a.delegates.length }} agents</dd>
          </div>
        </dl>
      </article>
    </div>
  </section>
</template>

<style scoped>
.mx-gallery-filter {
  display: flex;
  gap: 8px;
  margin: 16px 0;
}
.mx-gallery-filter button {
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--mx-line);
  color: var(--mx-muted);
  transition: all 0.2s ease;
}
.mx-gallery-filter button.on {
  color: var(--mx-ink);
  border-color: var(--mx-teal);
  background: var(--mx-teal-soft);
}
.mx-gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.mx-agent {
  border: 1px solid var(--mx-line);
  border-radius: 12px;
  padding: 14px;
  background: var(--mx-panel);
  transition: border-color 0.25s ease, transform 0.25s ease, box-shadow 0.25s ease;
  animation: mx-in 0.4s ease both;
}
.mx-agent:hover {
  border-color: var(--mx-teal);
  transform: translateY(-2px);
  box-shadow: var(--mx-glow);
}
.mx-agent.coordinator {
  border-color: color-mix(in srgb, var(--mx-gold) 50%, var(--mx-line));
}
@keyframes mx-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.mx-agent header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.mx-agent-id {
  font-size: 14px;
  font-weight: 600;
  background: none !important;
  padding: 0 !important;
}
.mx-agent-desc {
  font-size: 13px;
  line-height: 1.5;
  color: var(--mx-muted);
  margin: 8px 0 !important;
}
dl {
  margin: 0;
  display: grid;
  gap: 6px;
  font-size: 12px;
}
dl div {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 6px;
}
dt {
  color: var(--mx-muted);
  font-family: var(--vp-font-family-mono);
}
dd {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>
