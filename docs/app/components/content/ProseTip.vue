<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <ToolsCallout kind="tip" :title="title"><slot mdc-unwrap="p" /></ToolsCallout>
</template>
