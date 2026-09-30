<script setup lang="ts">
const { views, answers, cases, paused, hostIndex, caseIndex, step } = useLandingHosts();
</script>

<template>
  <div class="tools-landing not-prose">
    <LandingHero
      :views="views"
      :host-index="hostIndex"
      @step="step"
      @pause="paused = $event"
    />

    <LandingFeature
      title="One file, zero dialects"
      to="/guide/defining-tools"
      link="Defining tools"
      :checks="[
        'Type comes from @agntn/tools, never from a bare typebox import',
        'effect: read, write or destructive. MCP hints and OMP approval follow from it',
        'A literal union is refused at defineTool. Use Type.Enum, it errors in plain words',
      ]"
    >
      This is the whole tool. Name, schema, what it does to the world, and
      <code class="tools-code">execute</code>. No MCP handler, no Pi wrapper, no OMP copy of the
      schema written with a different TypeBox. <code class="tools-code">defineTool</code> checks the
      schema the moment you write it, so an open object or a sloppy union blows up in your editor,
      not in a model's hands three weeks later.
      <template #visual>
        <LandingDefinition />
      </template>
    </LandingFeature>

    <LandingFeature
      title="Same mistake, same answer, four hosts"
      to="/guide/validation"
      link="Validation and errors"
      :checks="[
        'An unknown key names itself and the keys the tool takes',
        'An enum lists its values, so the model stops guessing',
        'The core checks every call, even when a host skips its own check',
      ]"
      reverse
    >
      Models misspell arguments. All the time. <code class="tools-code">seperator</code> instead of
      <code class="tools-code">separator</code> gets silently dropped by a lot of tool code, and the
      call does something else than asked. Here the core checks first and every host hands the
      model the same lines. Only the channel differs. MCP says
      <code class="tools-code">isError</code>, Pi and OMP throw, the AI SDK refuses the input.
      <template #visual>
        <LandingValidation
          :cases="cases"
          :answers="answers"
          :case-index="caseIndex"
          @step="step"
          @pause="paused = $event"
        />
      </template>
    </LandingFeature>

    <LandingFeature
      title="The OMP trap, already sprung"
      to="/hosts/omp"
      link="OMP"
      :checks="[
        'TypeBox is bundled into dist as one chunk, nothing left for OMP to rewrite',
        'defineTool refuses a schema that turned into a function',
        'The OMP schema travels through the host\'s own Type.Unsafe',
      ]"
    >
      OMP quietly rewrites every bare <code class="tools-code">typebox</code> import in an extension
      to its own library, where schemas are functions. The validator you imported next to it then
      looks at a function and says yes to everything. Fun one. And TypeBox is hundreds of small
      files, each one passing OMP's loader on every start. Both are fixed once, here, so no
      extension has to find out the hard way.
      <template #visual>
        <LandingTrap />
      </template>
    </LandingFeature>

    <LandingFeature
      title="Hostile text stays on one line"
      to="/guide/validation#one-line-per-problem"
      link="sanitizeLine"
      :checks="[
        'Escape sequences out, the same pattern Node uses',
        'Newlines, U+2028 and bidi overrides turn into spaces',
        'Error text from MCP and every OMP status line goes through it',
      ]"
      reverse
    >
      A tool name or an argument ends up in an error message. So does whatever a provider answered.
      One raw newline in there and the next line reads like the tool said it. One bidi override and
      the terminal prints it backwards. <code class="tools-code">sanitizeLine</code> keeps it to one
      honest line, and it runs in your browser right now, not a screenshot of it.
      <template #visual>
        <LandingSanitize :tick="caseIndex" @pause="paused = $event" />
      </template>
    </LandingFeature>

    <section class="tools-section">
      <div class="mx-auto w-full max-w-[var(--ui-container)] px-8 py-20 sm:px-12 lg:px-16">
        <LandingStart />
      </div>
    </section>
  </div>
</template>
