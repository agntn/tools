<script setup lang="ts">
/**
 * A bare `typebox` import in an OMP extension against `Type` from `@agntn/tools`, row by row. Start
 * cost measured on compiled OMP 18.4.4: hyperfine medians of `omp models` with one extension loaded.
 */
const ROWS = [
  { label: "import", before: '"typebox"', after: '"@agntn/tools"' },
  { label: "schema", before: "a function", after: "JSON Schema" },
  { label: "Value.Check", before: "always true", after: "a real answer" },
  { label: "bad input", before: "accepted", after: "refused" },
  { label: "loaded", before: "688 modules", after: "1 chunk" },
  { label: "start cost", before: "+200 ms", after: "+20 ms" },
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
        <span>Before → after <span aria-hidden="true">[ bare typebox, then @agntn/tools ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <dl class="console-readout-rows trap-rows">
        <div v-for="row in ROWS" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd class="trap-pair">
            <span class="trap-danger">{{ row.before }}</span>
            <span class="trap-arrow" aria-hidden="true">→</span>
            <span class="trap-after">{{ row.after }}</span>
          </dd>
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
.trap-pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  white-space: nowrap;
}
.trap-pair > span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.trap-arrow {
  color: var(--ui-text-dimmed);
}
.trap-after {
  color: var(--console-accent);
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
