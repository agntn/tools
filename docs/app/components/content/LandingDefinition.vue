<script setup lang="ts">
import source from "../../utils/demo-tool.ts?raw";
import { tokens } from "../../utils/tokens";

const { copied, copy } = useCopied();

/**
 * The file this site registers with every host, as it is on disk. The section talks about the
 * definition, not the slug logic, so `execute` folds to its signature; copy hands out the whole file.
 */
const all = source.trimEnd().split("\n");
const start = all.findIndex((line) => line.startsWith("export const slugTool"));
const executeAt = all.findIndex((line) => line.trimStart().startsWith("execute("));
const folded = all.length - executeAt - 2;
const lines = [
  ...all.slice(start, executeAt),
  `${all[executeAt]!.replace(/\{$/u, "")}{ /* ${folded} lines of slug */ },`,
  "});",
];
</script>

<template>
  <section class="tool-console landing-file" aria-label="The whole tool definition">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title file-name"><span class="console-tag">File</span>demo-tool.ts</span>
      <span class="console-meta">runs on this page</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true" />

    <div class="file-body">
      <p class="console-label console-rule-title">
        <span>Definition <span aria-hidden="true">[ name, schema, effect, execute ]</span></span>
        <span class="console-mark" aria-hidden="true" />
        <UButton
          color="neutral"
          variant="subtle"
          :icon="copied === 'file' ? 'i-lucide-check' : 'i-lucide-copy'"
          :label="copied === 'file' ? 'copied' : 'copy'"
          :aria-label="copied === 'file' ? 'Copied' : 'Copy the file'"
          @click="copy('file', source)"
        />
      </p>
      <!-- Numbers in their own column: an ellipsis on the line would hide a ::before number in Chrome. -->
      <!-- prettier-ignore -->
      <pre class="console-snippet file-lines"><code><span v-for="(line, index) in lines" :key="index" class="file-line"><span class="file-no" aria-hidden="true">{{ index + 1 }}</span><span class="file-code"><span v-for="(token, part) in tokens(line)" :key="part" :class="token.cls">{{ token.text }}</span></span></span></code></pre>
    </div>

    <footer class="console-footer console-footer-plain">
      <span>createMcpServer · registerPiTools · registerOmpTools · toAiTool</span>
    </footer>
  </section>
</template>

<style scoped>
.file-body {
  padding: 14px 20px 18px;
}
.file-lines {
  margin: 12px 0 0;
  max-height: none;
  font-size: 11.5px;
}
.file-line {
  display: grid;
  grid-template-columns: 2.25em minmax(0, 1fr);
  gap: 1em;
  min-height: 1.7em;
}
.file-no {
  text-align: right;
  color: var(--ui-text-dimmed);
  user-select: none;
}
.file-code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
}
@media (width < 400px) {
  .file-body {
    padding-inline: 14px;
  }
}
</style>
