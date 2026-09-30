<script setup lang="ts">
import rootPackage from "../../../../package.json";
import { HOSTS, type HostView } from "../../utils/hosts";

defineProps<{ views: readonly HostView[] | null | undefined; hostIndex: number }>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

const INSTALL = "pnpm add @agntn/tools";
/** Runtime dependencies of the published package. TypeBox is bundled, the hosts are optional peers. */
const RUNTIME_DEPENDENCIES = Object.keys(
  (rootPackage as { dependencies?: Record<string, string> }).dependencies ?? {},
).length;
const { copied, copy } = useCopied();
</script>

<template>
  <header class="tools-hero hero-page">
    <div class="hero-zone">
      <span class="hero-cross hero-cross-tl" aria-hidden="true">+</span>
      <span class="hero-cross hero-cross-tr" aria-hidden="true">+</span>
      <span class="hero-bracket hero-bracket-l" aria-hidden="true" />
      <span class="hero-bracket hero-bracket-r" aria-hidden="true" />

      <p class="console-id">
        <span class="console-id-tag">ID</span>
        <span>@agntn/tools</span>
        <span class="console-id-sep" aria-hidden="true">/</span>
        <span>v{{ rootPackage.version }}</span>
      </p>

      <h1 class="hero-title">Write the tool once. <span>Every host gets it.</span></h1>
      <p class="hero-lead">
        MCP wants an inputSchema, Pi wants parameters, OMP swaps your TypeBox for its own and the AI
        SDK wants something else again. Same tool, four dialects, and they drift the moment you fix
        one and forget the rest. So don't keep four. Define it here and let the adapters do the
        paperwork.
      </p>

      <dl class="hero-metrics">
        <div>
          <dt>Hosts</dt>
          <dd>{{ HOSTS.length }}</dd>
          <dd class="hero-metric-sub">{{ HOSTS.map((host) => host.short).join(" · ") }}</dd>
        </div>
        <div>
          <dt>Runtime deps</dt>
          <dd>{{ RUNTIME_DEPENDENCIES }}</dd>
          <dd class="hero-metric-sub">TypeBox rides inside dist</dd>
        </div>
        <div>
          <dt>Definitions per tool</dt>
          <dd class="hero-metric-accent">1</dd>
          <dd class="hero-metric-sub">the rest is adapters</dd>
        </div>
      </dl>

      <div class="console-actions">
        <UButton
          to="/guide"
          color="primary"
          variant="solid"
          trailing-icon="i-lucide-arrow-right"
          label="Get started"
        />
        <UButton
          to="https://github.com/agntn/tools"
          target="_blank"
          color="neutral"
          variant="outline"
          icon="i-simple-icons-github"
          label="Star on GitHub"
        />
      </div>
      <div class="console-install">
        <span class="console-install-tag">Install</span>
        <code><span class="console-install-prompt">$</span> {{ INSTALL }}</code>
        <UButton
          color="neutral"
          variant="subtle"
          :icon="copied === 'install' ? 'i-lucide-check' : 'i-lucide-copy'"
          :aria-label="copied === 'install' ? 'Copied' : 'Copy install command'"
          @click="copy('install', INSTALL)"
        />
      </div>
    </div>

    <!-- One definition, registered by each adapter in turn, and what that host ends up holding. -->
    <div class="hero-instrument">
      <svg class="hero-circuit" viewBox="0 0 160 56" aria-hidden="true">
        <path class="hero-circuit-rail" d="M80 0V16L96 32V56" />
        <path :key="hostIndex" class="hero-circuit-live" d="M80 0V16L96 32V56" pathLength="1" />
        <path class="hero-circuit-seg" d="M96 38V48" />
        <rect class="hero-circuit-node" x="92.5" y="52.5" width="7" height="7" />
      </svg>
      <span class="hero-circuit-tag" aria-hidden="true">register</span>
      <LandingHosts
        :views="views"
        :host-index="hostIndex"
        @step="emit('step', $event)"
        @pause="emit('pause', $event)"
      />
    </div>
  </header>
</template>
