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

/** What the core says before any host sees the call, or what execute said when the input was fine. */
const verdict = computed(() => {
  if (sample.value.problems.length > 0) return sample.value.problems;
  const mcp = answer.value?.mcp;
  return mcp?.failed ? [mcp.text] : ["Nothing wrong with it."];
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

    <div class="check-body">
      <p class="console-label console-rule-title">
        <span>Core <span aria-hidden="true">[ validateInput, then execute ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <ul :key="sample.label" class="check-lines console-animate">
        <li v-for="line in verdict" :key="line" :class="{ 'check-ok': sample.problems.length === 0 && !answer?.mcp.failed }">
          {{ line }}
        </li>
      </ul>

      <p class="console-label console-rule-title">
        <span>Hosts <span aria-hidden="true">[ channel · what the model reads ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <dl :key="sample.label" class="console-readout-rows console-animate check-hosts">
        <div v-for="(host, index) in HOSTS" :key="host.key" :style="{ animationDelay: `${index * 45}ms` }">
          <dt>{{ host.short }}</dt>
          <dd>
            <UTooltip :text="answer?.[host.key].text ?? ''">
              <span class="check-line"
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
.check-body {
  display: grid;
  gap: 12px;
  padding: 14px 20px 18px;
}
.check-lines {
  display: grid;
  gap: 6px;
  min-height: 3.2em;
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.55;
  color: #ff7b72;
}
.check-lines .check-ok {
  color: var(--ui-text-highlighted);
}
.landing-check .check-hosts > div {
  grid-template-columns: 4.5rem minmax(0, 1fr);
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
  .check-body {
    padding-inline: 14px;
  }
}
</style>
