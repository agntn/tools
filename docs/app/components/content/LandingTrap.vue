<script setup lang="ts">
/** Measured on compiled OMP 18.4.4: hyperfine medians of `omp models` with one extension loaded. */
const BEFORE = [
  { label: "import", value: 'import { Type } from "typebox"' },
  { label: "schema", value: "a function, not JSON Schema", danger: true },
  { label: "Value.Check", value: "true, for anything at all", danger: true },
  { label: "start cost", value: "+200 ms, 688 modules", danger: true },
];
const AFTER = [
  { label: "import", value: 'import { Type } from "@agntn/tools"' },
  { label: "OMP schema", value: "pi.typebox.Type.Unsafe(json)" },
  { label: "bad input", value: "refused by OMP and by the core", accent: true },
  { label: "start cost", value: "+20 ms, inside the noise", accent: true },
];
</script>

<template>
  <section class="tool-console landing-trap" aria-label="OMP's typebox rewrite, before and after">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title"><span class="console-tag">Log</span>omp extension · typebox</span>
      <span class="console-meta">OMP 18.4.4</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true" />

    <div class="trap-body">
      <p class="console-label console-rule-title">
        <span>Before <span aria-hidden="true">[ a bare typebox import ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <dl class="console-readout-rows trap-rows">
        <div v-for="row in BEFORE" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd :class="{ 'trap-danger': row.danger }">{{ row.value }}</dd>
        </div>
      </dl>
      <p class="console-label console-rule-title">
        <span>After <span aria-hidden="true">[ Type from @agntn/tools ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <dl class="console-readout-rows trap-rows">
        <div v-for="row in AFTER" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd :class="{ 'console-accent': row.accent }">{{ row.value }}</dd>
        </div>
      </dl>
    </div>

    <footer class="console-footer console-footer-plain">
      <span>Start cost is the median of 40 OMP starts</span>
    </footer>
  </section>
</template>

<style scoped>
.trap-body {
  display: grid;
  gap: 12px;
  padding: 14px 20px 18px;
}
.landing-trap .trap-rows > div {
  grid-template-columns: 6.5rem minmax(0, 1fr);
}
.landing-trap .trap-rows dt {
  text-transform: none;
  letter-spacing: 0.02em;
}
.landing-trap .trap-rows dd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trap-danger {
  color: #ff7b72;
}
@media (width < 400px) {
  .trap-body {
    padding-inline: 14px;
  }
}
</style>
