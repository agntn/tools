<script setup lang="ts">
import { CONCEPTS, HOST_META, HOSTS, type HostView } from "../../utils/hosts";

const props = defineProps<{ views: readonly HostView[] | null | undefined; hostIndex: number }>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

/** One sentence per host: what's special about the way it takes a tool. */
const NOTES: Record<string, string> = {
  mcp: "A real MCP server, listed by a real client. The schema goes out as is.",
  pi: "Same JSON Schema, plus the prompt snippet Pi puts in front of the model.",
  omp: "OMP's own Type.Unsafe carries the schema, so pattern and maxLength survive.",
  ai: "jsonSchema() with the core's validator. Nobody writes it again in Zod.",
};

const host = computed(() => HOSTS[props.hostIndex]!);
const view = computed(() => props.views?.find((entry) => entry.key === host.value.key));
const call = computed(() => `${host.value.adapter}(…, [text_slug])`);

/** One row per idea, one cell per host: the field that host puts it in. */
const dialect = computed(() =>
  CONCEPTS.map((concept) => ({
    key: concept.key,
    cells: HOSTS.map((entry) => ({
      host: entry.key,
      field: props.views?.find((other) => other.key === entry.key)?.fields[concept.key] ?? null,
    })),
  })),
);
</script>

<template>
  <section
    class="tool-console console-wide landing-hosts"
    aria-label="One tool, registered by each host"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
    @focusin="emit('pause', true)"
    @focusout="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <UTooltip :text="call">
        <span class="console-title hosts-call" tabindex="0"
          ><span class="console-tag">Call</span
          ><Transition name="tools-roll" mode="out-in"
            ><span :key="host.key" class="tools-roll-slot">{{ host.adapter }}</span></Transition
          >(…, [<span class="tok-str">text_slug</span>])</span
        >
      </UTooltip>
      <span class="console-meta"
        >{{ HOST_META[host.key].peer }} · {{ String(hostIndex + 1).padStart(2, "0") }} /
        {{ String(HOSTS.length).padStart(2, "0") }}</span
      >
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="host.key" class="console-cursor" />
    </div>

    <div class="console-band console-subject-band hosts-subject">
      <div :key="host.key" class="console-scan" aria-hidden="true" />
      <div class="hosts-left">
        <div class="console-identity-block">
          <ConsoleReticle :key="host.key" :icon="host.icon" />
          <!-- Every host's name sits in the same cell, hidden, so the band keeps the tallest one's height. -->
          <div class="hosts-names">
            <div
              v-for="other in HOSTS"
              :key="other.key"
              class="console-name"
              :class="{ 'hosts-sizer': other.key !== host.key }"
              :aria-hidden="other.key !== host.key ? 'true' : undefined"
            >
              <span class="console-label">Host / <span class="console-label-key">{{ other.short }}</span></span>
              <h3>{{ other.name }}</h3>
              <p class="console-about">{{ NOTES[other.key] }}</p>
            </div>
          </div>
        </div>

        <div class="hosts-board">
          <p class="console-label console-rule-title">
            <span>Dialect <span aria-hidden="true">[ one tool, the field each host puts it in ]</span></span>
            <span class="console-mark" aria-hidden="true" />
          </p>
          <div class="hosts-map" role="table" aria-label="The field each host uses for the same idea">
            <div class="hosts-map-row" role="row">
              <span role="columnheader" />
              <span
                v-for="entry in HOSTS"
                :key="entry.key"
                role="columnheader"
                class="hosts-map-head"
                :data-lit="entry.key === host.key ? '' : undefined"
                >{{ entry.short }}</span
              >
            </div>
            <div v-for="row in dialect" :key="row.key" class="hosts-map-row" role="row">
              <span role="rowheader" class="console-tag hosts-map-concept">{{ row.key }}</span>
              <span
                v-for="cell in row.cells"
                :key="cell.host"
                role="cell"
                class="hosts-map-cell"
                :data-lit="cell.host === host.key ? '' : undefined"
                :data-none="cell.field === null ? '' : undefined"
                >{{ cell.field ?? "—" }}</span
              >
            </div>
          </div>
        </div>
      </div>

      <div class="console-readout">
        <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
          <circle cx="3" cy="12" r="2.5" />
          <path d="M5.5 12H14L22 20H32" />
        </svg>
        <dl :key="host.key" class="console-readout-rows console-animate">
          <div v-for="(row, index) in view?.rows ?? []" :key="row.label" :style="{ animationDelay: `${index * 45}ms` }">
            <dt>{{ row.label }}</dt>
            <dd :class="{ 'console-accent': row.accent }">
              <UTooltip :text="row.value">
                <span class="hosts-line" tabindex="0">{{ row.value }}</span>
              </UTooltip>
            </dd>
          </div>
        </dl>
        <div class="console-gauge" :aria-label="`Host ${hostIndex + 1} of ${HOSTS.length}`">
          <span class="console-ticks" aria-hidden="true">
            <span
              v-for="(entry, index) in HOSTS"
              :key="entry.key"
              :class="entry.key === host.key ? 'console-tick-open' : 'console-tick-closed'"
              :style="{ animationDelay: `${index * 12}ms` }"
            />
          </span>
          <span class="console-gauge-read">host {{ hostIndex + 1 }} / {{ HOSTS.length }}</span>
        </div>
      </div>
    </div>

    <ConsoleResponse
      v-if="view"
      :title="`What ${host.name} received`"
      :text="view.registration"
      label="Full registration"
      source="the object the host got"
      description="Everything the adapter handed this host for text_slug. Functions are named, not printed."
    />

    <footer class="console-footer console-footer-plain">
      <NuxtLink :to="HOST_META[host.key].to" class="hosts-link"
        ><span aria-hidden="true">→ </span>{{ host.name }}<span> · {{ HOST_META[host.key].to }}</span></NuxtLink
      >
      <div class="console-controls" aria-label="Sample hosts">
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-left"
          aria-label="Previous host"
          @click="emit('step', -1)"
        />
        <span>Host</span>
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-right"
          aria-label="Next host"
          @click="emit('step', 1)"
        />
      </div>
    </footer>
  </section>
</template>

<style scoped>
.hosts-call {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hosts-names {
  display: grid;
  min-width: 0;
}
.hosts-names > .console-name {
  grid-area: 1 / 1;
}
.hosts-sizer {
  visibility: hidden;
}
.hosts-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.landing-hosts :deep(.console-readout-rows > div) {
  grid-template-columns: 7.5rem minmax(0, 1fr);
}
.landing-hosts :deep(.console-readout-rows dt) {
  text-transform: none;
  letter-spacing: 0.02em;
}
/* The left column: the host, then the same six ideas across all four hosts, this one's column lit. */
.hosts-left {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.hosts-board {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.hosts-board > .console-rule-title {
  margin: 0 0 2px;
}
.hosts-map {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.hosts-map-row {
  display: grid;
  grid-template-columns: 4.5rem repeat(4, minmax(0, 1fr));
  gap: 4px;
  align-items: center;
}
.hosts-map-concept {
  justify-self: start;
  margin: 0;
}
.hosts-map-head {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ui-text-dimmed);
  padding-left: 8px;
}
.hosts-map-head[data-lit] {
  color: var(--console-accent);
}
.hosts-map-cell {
  display: block;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-muted);
  background: var(--ui-bg);
  box-shadow: inset 0 0 0 1px var(--console-line);
}
.hosts-map-cell[data-none] {
  color: var(--ui-text-dimmed);
  box-shadow: inset 0 0 0 1px var(--ui-border-muted);
}
.hosts-map-cell[data-lit] {
  color: var(--console-accent);
  box-shadow: inset 0 0 0 1px var(--console-accent);
}
.hosts-map-cell[data-lit][data-none] {
  color: color-mix(in srgb, var(--console-accent) 55%, var(--ui-bg));
}
/* Side by side, the readout runs as tall as the map beside it; stacked, it keeps its own height. */
@container (width >= 46rem) {
  .hosts-subject > .console-readout {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    align-self: stretch;
  }
  .hosts-subject :deep(.console-readout-rows) {
    grid-auto-rows: minmax(2.5rem, 1fr);
  }
  .hosts-subject :deep(.console-readout-rows > div) {
    align-items: center;
  }
}
.hosts-link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
.hosts-link > span:last-child {
  color: var(--ui-text-dimmed);
}
.hosts-link:hover {
  color: var(--console-accent);
}
.hosts-link:focus-visible {
  outline: 1px solid var(--ui-primary);
  outline-offset: 3px;
}
@media (width < 640px) {
  .hosts-board > .console-rule-title > .console-mark {
    display: none;
  }
  .hosts-map-row {
    grid-template-columns: 3.75rem repeat(4, minmax(0, 1fr));
    gap: 3px;
  }
  .hosts-map-cell {
    padding: 0 4px;
    font-size: 11px;
  }
}
</style>
