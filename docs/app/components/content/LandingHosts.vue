<script setup lang="ts">
import { HOSTS, type HostView } from "../../utils/hosts";

const props = defineProps<{ views: readonly HostView[] | null | undefined; hostIndex: number }>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

/** One sentence per host: what's special about the way it takes a tool. */
const NOTES: Record<string, string> = {
  mcp: "A real MCP server, listed by a real client. The schema goes out as is, the hints come from effect.",
  pi: "Same JSON Schema, plus the prompt snippet and guidelines Pi puts in front of the model.",
  omp: "OMP gets the schema through its own Type.Unsafe, so pattern and maxLength survive the trip.",
  ai: "jsonSchema() with the core's validator, so nobody writes the schema again in Zod.",
};

const host = computed(() => HOSTS[props.hostIndex]!);
const view = computed(() => props.views?.find((entry) => entry.key === host.value.key));
const title = computed(() => `${host.value.adapter}(…, [text_slug])`);
</script>

<template>
  <section
    class="tool-console landing-hosts"
    aria-label="One tool, registered by each host"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
    @focusin="emit('pause', true)"
    @focusout="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <UTooltip :text="title">
        <span class="console-title"
          ><span class="console-tag">Call</span
          ><Transition name="tools-roll" mode="out-in"
            ><span :key="host.key" class="tools-roll-slot">{{ host.adapter }}</span></Transition
          >(…, [<span class="tok-str">text_slug</span>])</span
        >
      </UTooltip>
      <span class="console-meta">{{ String(hostIndex + 1).padStart(2, "0") }} / {{ String(HOSTS.length).padStart(2, "0") }}</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="host.key" class="console-cursor" />
    </div>

    <div class="hosts-subject">
      <div :key="host.key" class="console-scan" aria-hidden="true" />
      <div class="hosts-identity">
        <ConsoleReticle :key="host.key" :icon="host.icon" />
        <div class="hosts-name">
          <span class="console-label">Host / {{ host.short }}</span>
          <h3>{{ host.name }}</h3>
          <p class="hosts-note">{{ NOTES[host.key] }}</p>
        </div>
      </div>
      <div class="console-readout">
        <dl :key="host.key" class="console-readout-rows console-animate">
          <div
            v-for="(row, index) in view?.rows ?? []"
            :key="row.label"
            :style="{ animationDelay: `${index * 45}ms` }"
          >
            <dt>{{ row.label }}</dt>
            <dd :class="{ 'console-accent': row.accent }">
              <UTooltip :text="row.value">
                <span class="hosts-line">{{ row.value }}</span>
              </UTooltip>
            </dd>
          </div>
        </dl>
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

    <footer class="console-footer console-footer-plain hosts-footer">
      <span>One definition, {{ HOSTS.length }} registrations</span>
      <span class="hosts-steps">
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-left"
          aria-label="Previous host"
          @click="emit('step', -1)"
        />
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-right"
          aria-label="Next host"
          @click="emit('step', 1)"
        />
      </span>
    </footer>
  </section>
</template>

<style scoped>
.hosts-subject {
  position: relative;
  display: grid;
  gap: 16px;
  padding: 18px 20px 20px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Cpath d='M16 18h4m-2-2v4' fill='none' stroke='%23818a94' stroke-opacity='.1'/%3E%3C/svg%3E");
  background-size: 36px 36px;
  background-position: 24px 20px;
}
.hosts-subject > :not(.console-scan) {
  position: relative;
}
.hosts-identity {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
}
.hosts-name {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.hosts-name h3 {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--ui-text-highlighted);
}
.hosts-note {
  margin: 0;
  min-height: 3em;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.landing-hosts .console-readout-rows > div {
  grid-template-columns: 7.5rem minmax(0, 1fr);
}
.landing-hosts .console-readout-rows dt {
  text-transform: none;
  letter-spacing: 0.02em;
}
.hosts-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hosts-footer {
  align-items: center;
}
.hosts-steps {
  display: inline-flex;
  gap: 6px;
}
@media (width < 400px) {
  .hosts-subject {
    padding-inline: 14px;
  }
  .hosts-identity {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
