<script setup lang="ts">
import { data } from "../../data/agents.data.ts";

/** Every shipped agent in one table, read from metator/agents at build time. */
</script>

<template>
  <section class="mx-agents" aria-label="Agents">
    <table>
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col">Role</th>
          <th scope="col">What it does</th>
          <th scope="col">Writes</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in data.agents" :key="a.id" :data-agent="a.id">
          <td><code>{{ a.id }}</code></td>
          <td>{{ a.role }}</td>
          <td>{{ a.description }}</td>
          <td>{{ a.artifact ?? "" }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.mx-agents {
  margin: 20px 0;
  overflow-x: auto;
}
.mx-agents table {
  margin: 0;
  font-size: 14px;
}
.mx-agents td:first-child {
  white-space: nowrap;
}
</style>
