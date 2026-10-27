<script setup lang="ts">
import { choosePackageManager, PACKAGE_MANAGERS, type PackageManager, packageManager } from "../pm.ts";

/**
 * The package manager the whole documentation shows commands for: a compact select in the
 * navigation bar, buttons inside a page.
 */
withDefaults(defineProps<{ variant?: "select" | "buttons" }>(), { variant: "buttons" });
const onSelect = (e: Event) => choosePackageManager((e.target as HTMLSelectElement).value as PackageManager);
</script>

<template>
  <label v-if="variant === 'select'" class="mx-pm-select" title="Package manager for the commands in these docs">
    <span class="sr-only">Package manager</span>
    <select :value="packageManager" @change="onSelect">
      <option v-for="pm in PACKAGE_MANAGERS" :key="pm" :value="pm">{{ pm }}</option>
    </select>
  </label>
  <div v-else class="mx-pm" role="radiogroup" aria-label="Package manager for the commands in these docs">
    <button
      v-for="pm in PACKAGE_MANAGERS"
      :key="pm"
      type="button"
      role="radio"
      :aria-checked="pm === packageManager"
      :class="{ on: pm === packageManager }"
      :data-pm="pm"
      @click="choosePackageManager(pm)"
    >
      {{ pm }}
    </button>
  </div>
</template>

<style scoped>
.mx-pm-select {
  display: inline-flex;
  align-items: center;
  margin-left: 10px;
}
.mx-pm-select select {
  padding: 3px 22px 3px 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2394a3b8'/%3E%3C/svg%3E")
    no-repeat right 7px center;
  appearance: none;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--mx-teal);
  cursor: pointer;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.mx-pm {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}
.mx-pm button {
  padding: 2px 10px;
  border-radius: 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--vp-c-text-2);
  transition: background 0.2s ease, color 0.2s ease;
}
.mx-pm button.on {
  background: var(--mx-teal-soft);
  color: var(--mx-teal);
  font-weight: 600;
}
</style>
