<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <ToolsCallout kind="caution" :title="title"><slot mdc-unwrap="p" /></ToolsCallout>
</template>
