<script setup lang="ts">
import { chooseWay, WAYS, way } from "../way.ts";

/**
 * The way the reader installs and uses MetatorAI: the desktop app, or the terminal only. Every
 * `<Way app>` and `<Way cli>` block on every page follows it.
 */
</script>

<template>
  <div class="mx-way-switch" role="radiogroup" aria-label="How you install and use MetatorAI">
    <button
      v-for="w in WAYS"
      :key="w.id"
      type="button"
      role="radio"
      :aria-checked="w.id === way"
      :class="{ on: w.id === way }"
      :data-way="w.id"
      @click="chooseWay(w.id)"
    >
      <strong>{{ w.label }}</strong>
      <span>{{ w.sub }}</span>
    </button>
  </div>
</template>

<style scoped>
.mx-way-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  margin: 16px 0;
  padding: 4px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
}
.mx-way-switch button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 12px;
  border-radius: 7px;
  text-align: left;
  color: var(--vp-c-text-2);
}
.mx-way-switch button strong {
  font-size: 14px;
}
.mx-way-switch button span {
  font-size: 12px;
  line-height: 1.4;
}
.mx-way-switch button.on {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  box-shadow: 0 0 0 1px var(--vp-c-brand-1);
}
</style>
