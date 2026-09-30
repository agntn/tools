<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <ToolsCallout kind="warning" :title="title"><slot mdc-unwrap="p" /></ToolsCallout>
</template>
