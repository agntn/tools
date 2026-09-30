<script setup lang="ts">
import { CASES } from "../../composables/useLandingHosts";
import { callEveryHost, HOSTS, type HostAnswer, type HostKey } from "../../utils/hosts";

/** Extra starting points besides the landing's calls: things models really send. */
const PRESETS = [
  ...CASES.map((sample) => ({ label: sample.label, args: sample.args as object })),
  { label: "number", args: { text: 42 } },
  { label: "underscore", args: { text: "Über Café 2026", separator: "_" } },
  { label: "empty", args: {} },
] as const;

const route = useRoute();
const router = useRouter();

const source = ref(JSON.stringify(PRESETS[0]!.args, null, 2));
const parsed = computed<{ ok: true; value: unknown } | { ok: false; message: string }>(() => {
  try {
    return { ok: true, value: JSON.parse(source.value) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});
const answers = shallowRef<Record<HostKey, HostAnswer> | undefined>();
const running = ref(false);
const call = computed(() => `text_slug(${parsed.value.ok ? JSON.stringify(parsed.value.value) : "…"})`);

let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

/** Sends the arguments to every host 250 ms after the text stops changing. The newest call wins. */
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!parsed.value.ok) return;
    const own = ++generation;
    running.value = true;
    const result = await callEveryHost(parsed.value.value);
    if (own === generation) {
      answers.value = result;
      running.value = false;
    }
  }, 250);
}

function pick(args: object) {
  source.value = JSON.stringify(args, null, 2);
}

onMounted(() => {
  /** A prerendered page hydrates with an empty query; Nuxt restores it right after, once. */
  const stop = watch(
    () => route.query.args,
    (value) => {
      if (typeof value === "string") source.value = value;
      stop();
    },
  );
  if (typeof route.query.args === "string") {
    source.value = route.query.args;
    stop();
  }
  watch(source, (value) => {
    router.replace({ query: { args: value } });
    schedule();
  });
  schedule();
});

const CHANNEL: Record<HostAnswer["channel"], string> = {
  result: "result",
  isError: "isError",
  thrown: "thrown",
  refused: "refused",
};
</script>

<template>
  <section class="tool-console console-wide playground" aria-label="One call, sent to four hosts">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <UTooltip :text="call">
        <span class="console-title"><span class="console-tag">Call</span>{{ call }}</span>
      </UTooltip>
      <span class="console-meta">{{ HOSTS.length }} hosts · in this tab</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :class="['console-cursor', { 'console-cursor-busy': running }]" />
    </div>

    <div class="playground-body">
      <div class="playground-input">
        <p class="console-label console-rule-title">
          <span>Arguments <span aria-hidden="true">[ JSON, the way a host sends it ]</span></span>
          <span class="console-mark" aria-hidden="true" />
        </p>
        <div class="playground-presets">
          <UButton
            v-for="preset in PRESETS"
            :key="preset.label"
            :color="source === JSON.stringify(preset.args, null, 2) ? 'primary' : 'neutral'"
            variant="chip"
            :label="preset.label"
            @click="pick(preset.args)"
          />
        </div>
        <UTextarea
          v-model="source"
          variant="none"
          :rows="7"
          autoresize
          aria-label="Tool arguments as JSON"
          class="playground-source"
        />
        <UAlert
          v-if="!parsed.ok"
          color="error"
          variant="outline"
          icon="i-lucide-circle-alert"
          title="Not JSON yet"
          :description="parsed.message"
        />
      </div>

      <div class="playground-hosts">
        <p class="console-label console-rule-title">
          <span>Hosts <span aria-hidden="true">[ what each one ends up with ]</span></span>
          <span class="console-mark" aria-hidden="true" />
        </p>
        <ul class="playground-list">
          <li v-for="host in HOSTS" :key="host.key" class="playground-host">
            <span class="playground-glyph" aria-hidden="true"><UIcon :name="host.icon" /></span>
            <span class="playground-name">{{ host.short }}</span>
            <UBadge
              v-if="answers"
              :color="answers[host.key].failed ? 'error' : 'primary'"
              variant="outline"
              :label="CHANNEL[answers[host.key].channel]"
            />
            <pre class="playground-text">{{ answers?.[host.key].text ?? "…" }}</pre>
          </li>
        </ul>
      </div>
    </div>

    <ConsoleResponse v-if="answers" :title="call" :text="answers.mcp.text" source="MCP content[0].text" />

    <footer class="console-footer console-footer-plain">
      <span>createMcpServer · registerPiTools · registerOmpTools · toAiTool</span>
      <span class="console-meta">nothing leaves the tab</span>
    </footer>
  </section>
</template>

<style scoped>
.playground-body {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: 24px 32px;
  padding: 20px 24px 24px;
}
.playground-input,
.playground-hosts {
  display: grid;
  align-content: start;
  gap: 12px;
  min-width: 0;
}
.playground-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.playground-source :deep(textarea) {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}
.playground-list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.playground-host {
  display: grid;
  grid-template-columns: 28px 4.5rem auto minmax(0, 1fr);
  align-items: baseline;
  gap: 10px;
  padding: 10px 0;
  box-shadow: inset 0 -1px 0 var(--ui-border-muted);
}
.playground-glyph {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--ui-text-muted);
  box-shadow: inset 0 0 0 1px var(--ui-border);
  align-self: center;
}
.playground-name {
  font-family: var(--font-mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ui-text-muted);
}
.playground-text {
  grid-column: 2 / -1;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ui-text-highlighted);
}
@media (width < 56rem) {
  .playground-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (width < 640px) {
  .playground-body {
    padding: 16px 14px 20px;
  }
}
</style>
