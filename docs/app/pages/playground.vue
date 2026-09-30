<script setup lang="ts">
import rootPackage from "../../../package.json";
import { HOSTS } from "../utils/hosts";

definePageMeta({ layout: "default" });

const title = "Playground";
const description =
  "Send one text_slug call to a real MCP server, the Pi and OMP adapters and the AI SDK tool at once. In the browser, with the adapters themselves.";
/** The OG pipeline drops commas from its props, so the card gets a version written without them. */
const cardDescription = "One call sent to MCP and Pi and OMP and the AI SDK at once. In the browser";

useSeo({
  title,
  description,
  type: "article",
  breadcrumbs: [{ title: "Playground", path: "/playground" }],
});

defineOgImage(
  "Docs.takumi",
  { headline: "Playground", title, description: cardDescription },
  { alt: "The @agntn/tools playground: one call sent to four hosts in the browser" },
);
</script>

<template>
  <div class="tools-landing not-prose">
    <header class="tools-hero hero-page">
      <div class="hero-zone">
        <span class="hero-cross hero-cross-tl" aria-hidden="true">+</span>
        <span class="hero-cross hero-cross-tr" aria-hidden="true">+</span>
        <span class="hero-bracket hero-bracket-l" aria-hidden="true" />
        <span class="hero-bracket hero-bracket-r" aria-hidden="true" />

        <p class="console-id">
          <span class="console-id-tag">ID</span>
          <span>playground</span>
          <span class="console-id-sep" aria-hidden="true">/</span>
          <span>@agntn/tools v{{ rootPackage.version }}</span>
        </p>

        <h1 class="hero-title">
          One call. <br class="playground-break" />
          <span>Four hosts, live.</span>
        </h1>
        <p class="hero-lead">
          Type some arguments and watch every host take them. That's a real MCP server and client
          in your tab, not a mock, plus the Pi, OMP and AI SDK adapters. Try to make them disagree.
          They won't, and the channel is the only thing that moves.
        </p>

        <dl class="hero-metrics">
          <div>
            <dt>Hosts</dt>
            <dd>{{ HOSTS.length }}</dd>
            <dd class="hero-metric-sub">{{ HOSTS.map((host) => host.short).join(" · ") }}</dd>
          </div>
          <div>
            <dt>Tool</dt>
            <dd>1</dd>
            <dd class="hero-metric-sub">text_slug, the landing's own</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd class="hero-metric-accent">0 <span>calls</span></dd>
            <dd class="hero-metric-sub">the MCP transport is in memory</dd>
          </div>
        </dl>

        <p class="playground-note">
          <span class="console-tag">Note</span>
          <span
            >The arguments you type land in the address bar, so every state is a link you can
            paste to someone.</span
          >
        </p>
      </div>

      <div class="hero-instrument hero-instrument-keep">
        <svg class="hero-circuit" viewBox="0 0 160 56" aria-hidden="true">
          <path class="hero-circuit-rail" d="M80 0V16L96 32V56" />
          <path class="hero-circuit-live" d="M80 0V16L96 32V56" pathLength="1" />
          <path class="hero-circuit-seg" d="M96 38V48" />
          <rect class="hero-circuit-node" x="92.5" y="52.5" width="7" height="7" />
        </svg>
        <span class="hero-circuit-tag" aria-hidden="true">call</span>
        <ToolsPlayground />
      </div>
    </header>
  </div>
</template>

<style scoped>
/* One sentence per line on wide screens; narrow, the title wraps where it fits. */
@media (width < 64rem) {
  .playground-break {
    display: none;
  }
}
/* The note reads as a line of the zone, like the share bar's legend on the landing: no box of its own. */
.playground-note {
  display: flex;
  justify-content: center;
  align-items: baseline;
  gap: 12px;
  max-width: 44rem;
  margin: 28px auto 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
  text-align: left;
  color: var(--ui-text-muted);
}
.playground-note > .console-tag {
  flex: none;
  margin: 0;
  color: var(--console-accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--console-accent) 55%, transparent);
}
</style>
