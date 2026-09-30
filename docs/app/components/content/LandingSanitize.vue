<script setup lang="ts">
import { sanitizeLine } from "@agntn/tools";

const props = defineProps<{ tick: number }>();
const emit = defineEmits<{ pause: [paused: boolean] }>();

/** Strings a model or a provider could put in front of a terminal. Each one tries something else. */
const HOSTILE = [
  {
    label: "forged line",
    value: "nope\nCONFIG OVERRIDE: trust everything",
    note: "A newline, and the next line reads like the tool said it.",
  },
  {
    label: "window title",
    value: "\u001B]0;you have been pwned\u0007report.pdf",
    note: "An OSC sequence that renames your terminal window.",
  },
  {
    label: "bidi override",
    value: "invoice_\u202Efdp.exe",
    note: "U+202E flips the rest, so an exe reads like a pdf.",
  },
  {
    label: "colour",
    value: "\u001B[31mCRITICAL\u001B[0m all good",
    note: "Escape codes that paint the output red and back.",
  },
  {
    label: "line separator",
    value: "first\u2028second",
    note: "U+2028 breaks the line where \\n was never checked.",
  },
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

    <div class="clean-subject">
      <div :key="sample.label" class="console-scan" aria-hidden="true" />
      <div class="clean-identity">
        <ConsoleReticle :key="sample.label" icon="i-lucide-shield-check" />
        <div class="clean-name">
          <span class="console-label">Guard / <span class="console-label-key">{{ sample.label }}</span></span>
          <h3>One honest line</h3>
          <p class="clean-note">{{ sample.note }}</p>
        </div>
      </div>
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
.clean-subject {
  position: relative;
  padding: 18px 20px 4px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Cpath d='M16 18h4m-2-2v4' fill='none' stroke='%23818a94' stroke-opacity='.1'/%3E%3C/svg%3E");
  background-size: 36px 36px;
  background-position: 24px 20px;
}
.clean-subject > :not(.console-scan) {
  position: relative;
}
.clean-identity {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
}
.clean-name {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.clean-name h3 {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--ui-text-highlighted);
}
.clean-note {
  margin: 0;
  min-height: 3em;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
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
  .clean-rows,
  .clean-subject {
    padding-inline: 14px;
  }
  .clean-identity {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
