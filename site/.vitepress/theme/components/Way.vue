<script setup lang="ts">
import { computed } from "vue";
import { way } from "../way.ts";

/**
 * Content for one way only: `<Way app>` for the desktop app, `<Way cli>` for the terminal. The
 * WaySwitch shows one of them. A block holds no heading, so the page's outline stays true.
 */
const props = defineProps<{ app?: boolean; cli?: boolean }>();
const mine = computed(() => (props.app ? "app" : "cli"));
</script>

<template>
  <div v-show="way === mine" class="mx-way" :data-way="mine">
    <slot />
  </div>
</template>
