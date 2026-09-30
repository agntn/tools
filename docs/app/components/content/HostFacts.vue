<script setup lang="ts">
import { HOST_META, HOSTS, hostViews, peerRange, type HostKey } from "../../utils/hosts";

const props = defineProps<{ name: HostKey }>();

const position = HOSTS.findIndex((host) => host.key === props.name) + 1;
const host = HOSTS[position - 1]!;
const meta = HOST_META[props.name];
const { data: views } = useAsyncData("host-views", () => hostViews());
const view = computed(() => views.value?.find((entry) => entry.key === props.name));
</script>

<template>
  <section class="tool-console console-wide host-facts not-prose my-6" aria-label="Host record">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title"
        ><span class="console-tag">ID</span>{{ host.key
        }}<span class="console-file">{{ String(position).padStart(2, "0") }} / {{ String(HOSTS.length).padStart(2, "0") }}</span></span
      >
      <span class="console-meta">{{ meta.peer }}</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true"><span class="console-cursor" /></div>

    <div class="console-band console-subject-band">
      <div class="console-scan" aria-hidden="true" />
      <div class="console-identity-block">
        <ConsoleReticle :key="host.key" :icon="host.icon" />
        <div class="console-name">
          <span class="console-label">Host / {{ host.short }}</span>
          <h3>{{ host.name }}</h3>
          <p class="console-about">{{ meta.blurb }}.</p>
        </div>
      </div>

      <div class="console-readout">
        <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
          <circle cx="3" cy="12" r="2.5" />
          <path d="M5.5 12H14L22 20H32" />
        </svg>
        <dl class="console-readout-rows">
          <div v-for="row in view?.rows ?? []" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd :class="{ 'console-accent': row.accent }">
              <UTooltip :text="row.value">
                <span class="host-line" tabindex="0">{{ row.value }}</span>
              </UTooltip>
            </dd>
          </div>
        </dl>
      </div>
    </div>

    <div class="console-band">
      <p class="console-label console-rule-title">
        <span>Access <span aria-hidden="true">[ import · peer · adapter ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <dl class="host-leads">
        <dd class="console-lead">
          <span class="console-tag">Import</span>
          <code class="host-code"
            ><span class="tok-kw">import</span> { {{ host.adapter }} } <span class="tok-kw">from</span
            >{{ " " }}<span class="tok-str">"{{ meta.entry }}"</span></code
          >
          <span class="console-leader" aria-hidden="true" />
        </dd>
        <dd class="console-lead">
          <span class="console-tag">Peer</span>
          <code class="host-code"
            >{{ meta.peer }} <span class="text-dimmed">{{ peerRange(name) }}</span></code
          >
          <span class="console-leader" aria-hidden="true" />
        </dd>
        <dd class="console-lead">
          <span class="console-tag">Fails</span>
          <code class="host-code">{{ meta.failure }}</code>
          <span class="console-leader" aria-hidden="true" />
        </dd>
      </dl>
    </div>

    <ConsoleResponse
      v-if="view"
      :title="`What ${host.name} received for text_slug`"
      :text="view.registration"
      label="Full registration"
      source="the object the host got"
      description="Everything the adapter handed this host for text_slug. Functions are named, not printed."
    />

    <footer class="console-footer console-footer-plain">
      <NuxtLink to="/hosts"><span aria-hidden="true">← </span>every host</NuxtLink>
      <span class="console-meta">registered in your browser</span>
    </footer>
  </section>
</template>

<style scoped>
/* Same label column as the landing's readout, so the longest value (MCP hints) fits. */
.host-facts :deep(.console-readout-rows > div) {
  grid-template-columns: 7.5rem minmax(0, 1fr);
}
.host-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-leads {
  display: grid;
  gap: 8px;
  margin: 0;
}
.host-leads > dd {
  min-width: 0;
  margin: 0;
}
.host-code {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
</style>
