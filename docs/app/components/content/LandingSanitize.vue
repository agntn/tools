<script setup lang="ts">
import { sanitizeLine } from "@agntn/tools";

const props = defineProps<{ tick: number }>();
const emit = defineEmits<{ pause: [paused: boolean] }>();

/** Strings a model or a provider could put in front of a terminal. Each one tries something else. */
const HOSTILE = [
  { label: "forged line", value: "nope\nCONFIG OVERRIDE: trust everything" },
  { label: "window title", value: "\u001B]0;you have been pwned\u0007report.pdf" },
  { label: "bidi override", value: "invoice_\u202Efdp.exe" },
  { label: "colour", value: "\u001B[31mCRITICAL\u001B[0m all good" },
  { label: "line separator", value: "first\u2028second" },
] as const;

const sample = computed(() => HOSTILE[props.tick % HOSTILE.length]!);
/** The input with every escape visible, the way JSON would print it. */
const shown = computed(() =>
  JSON.stringify(sample.value.value).replaceAll(/[\u2028\u202E]/gu, (char) => `\\u${char.codePointAt(0)!.toString(16).toUpperCase()}`),
);
const clean = computed(() => sanitizeLine(sample.value.value));
</script>

<template>
  <section
    class="tool-console landing-clean"
    aria-label="sanitizeLine on hostile text"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title"><span class="console-tag">Call</span>sanitizeLine(value)</span>
      <span class="console-meta">{{ sample.label }}</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="sample.label" class="console-cursor" />
    </div>

    <dl :key="sample.label" class="console-readout-rows console-animate clean-rows">
      <div>
        <dt>in</dt>
        <dd class="clean-in">{{ shown }}</dd>
      </div>
      <div>
        <dt>out</dt>
        <dd class="console-accent">"{{ clean }}"</dd>
      </div>
    </dl>

    <footer class="console-footer console-footer-plain">
      <span>Computed by @agntn/tools in this tab</span>
    </footer>
  </section>
</template>

<style scoped>
.clean-rows {
  padding: 16px 20px 18px;
}
.landing-clean .clean-rows > div {
  grid-template-columns: 3rem minmax(0, 1fr);
}
.landing-clean .clean-rows dd {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.clean-in {
  color: #ff7b72;
}
@media (width < 400px) {
  .clean-rows {
    padding-inline: 14px;
  }
}
</style>
