<script setup lang="ts">
import { HOSTS, type HostAnswer, type HostKey } from "../../utils/hosts";

const props = defineProps<{
  cases: readonly { label: string; args: object; problems: readonly string[] }[];
  answers: readonly Record<HostKey, HostAnswer>[] | null | undefined;
  caseIndex: number;
}>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

const sample = computed(() => props.cases[props.caseIndex]!);
const answer = computed(() => props.answers?.[props.caseIndex]);
const call = computed(() => `text_slug(${JSON.stringify(sample.value.args)})`);

/** What happened to the call: refused by the core, failed in execute, or answered. */
const verdict = computed(() => {
  if (sample.value.problems.length > 0) {
    return { word: "refused", name: "Refused before execute", icon: "i-lucide-circle-x", line: sample.value.problems.join(" ") };
  }
  const mcp = answer.value?.mcp;
  if (mcp?.failed) {
    return { word: "isError", name: "Failed inside execute", icon: "i-lucide-triangle-alert", line: mcp.text };
  }
  return { word: "ok", name: "Answered", icon: "i-lucide-circle-check", line: "Nothing wrong with it. Every host gets the slug." };
});
</script>

<template>
  <section
    class="tool-console landing-check"
    aria-label="One call, four hosts"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
    @focusin="emit('pause', true)"
    @focusout="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <UTooltip :text="call">
        <!-- No roll here: the call is long, and an inline-block slot would hide it behind a bare ellipsis. -->
        <span class="console-title"><span class="console-tag">Call</span>{{ call }}</span>
      </UTooltip>
      <span class="console-meta">{{ sample.label }}</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="sample.label" class="console-cursor" />
    </div>

    <!-- The verdict on the crosses grid, then what each host ends up with in the readout. -->
    <div class="check-subject">
      <div :key="sample.label" class="console-scan" aria-hidden="true" />
      <div class="check-identity">
        <ConsoleReticle :key="sample.label" :icon="verdict.icon" />
        <div class="check-name">
          <span class="console-label">Core / <span class="console-label-key">{{ verdict.word }}</span></span>
          <h3>{{ verdict.name }}</h3>
          <UTooltip :text="verdict.line">
            <p class="check-note" :class="{ 'check-fail': verdict.word !== 'ok' }" tabindex="0">{{ verdict.line }}</p>
          </UTooltip>
        </div>
      </div>
      <div class="console-readout">
        <dl :key="sample.label" class="console-readout-rows console-animate check-hosts">
          <div v-for="(host, index) in HOSTS" :key="host.key" :style="{ animationDelay: `${index * 45}ms` }">
            <dt>{{ host.short }}</dt>
            <dd>
              <UTooltip :text="answer?.[host.key].text ?? ''">
                <span class="check-line" tabindex="0"
                  ><span :class="answer?.[host.key].failed ? 'check-fail' : 'console-accent'">{{
                    answer?.[host.key].channel ?? "…"
                  }}</span>
                  {{ answer?.[host.key].text }}</span
                >
              </UTooltip>
            </dd>
          </div>
        </dl>
      </div>
    </div>

    <ConsoleResponse v-if="answer" :title="call" :text="answer.mcp.text" />

    <footer class="console-footer console-footer-plain hosts-footer">
      <span>Same text everywhere, only the channel moves</span>
      <span class="check-steps">
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-left"
          aria-label="Previous call"
          @click="emit('step', -1)"
        />
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-right"
          aria-label="Next call"
          @click="emit('step', 1)"
        />
      </span>
    </footer>
  </section>
</template>

<style scoped>
.check-subject {
  position: relative;
  display: grid;
  gap: 12px;
  padding: 14px 20px 14px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Cpath d='M16 18h4m-2-2v4' fill='none' stroke='%23818a94' stroke-opacity='.1'/%3E%3C/svg%3E");
  background-size: 36px 36px;
  background-position: 24px 20px;
}
.check-subject > :not(.console-scan) {
  position: relative;
}
.check-identity {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
}
.check-name {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.check-name h3 {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--ui-text-highlighted);
}
/* One sentence, two lines at most: the full core line lives in the tooltip and the dialog. */
.check-note {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.landing-check .check-hosts > div {
  grid-template-columns: 4.5rem minmax(0, 1fr);
  min-height: 0;
  padding-block: 5px;
}
.landing-check .check-hosts dt {
  text-transform: none;
  letter-spacing: 0.02em;
}
.check-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.check-fail {
  color: #ff7b72;
}
.hosts-footer {
  align-items: center;
}
.check-steps {
  display: inline-flex;
  gap: 6px;
}
@media (width < 400px) {
  .check-subject {
    padding-inline: 14px;
  }
  .check-identity {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
