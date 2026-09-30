<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import { HOST_META, HOSTS, peerRange, type HostKey } from "../../utils/hosts";
import { ROSTER_CLASS, ROSTER_TABLE_UI } from "../../utils/roster";

interface Row {
  readonly key: HostKey;
  readonly name: string;
  readonly icon: string;
  readonly to: string;
  readonly adapter: string;
  readonly peer: string;
  readonly range: string;
  readonly schema: string;
  readonly failure: string;
}

const rows = HOSTS.map<Row>((host) => ({
  key: host.key,
  name: host.name,
  icon: host.icon,
  to: HOST_META[host.key].to,
  adapter: host.adapter,
  peer: HOST_META[host.key].peer,
  range: peerRange(host.key),
  schema: HOST_META[host.key].schema,
  failure: HOST_META[host.key].failure,
}));

const sorting = ref<{ id: string; desc: boolean }[]>([]);
const roster = useTemplateRef<HTMLElement>("roster");
useRosterFlip(
  () => roster.value,
  () => sorting.value,
);

const columns: TableColumn<Row>[] = [
  { accessorKey: "name", header: "Host", sortingFn: "text", meta: { class: { th: "w-[13rem]" } } },
  { accessorKey: "adapter", header: "Adapter", sortingFn: "text", meta: { class: { th: "w-[11rem]" } } },
  { accessorKey: "peer", header: "Peer", sortingFn: "text", meta: { class: { td: "min-w-0" } } },
  { id: "failure", header: "Failure", enableSorting: false, meta: { class: { th: "w-[13rem]" } } },
];

const order = computed(() => {
  const [first] = sorting.value;
  if (first === undefined) return "walk order";
  const label = columns.find((column) => "accessorKey" in column && column.accessorKey === first.id)?.header;
  return `by ${String(label).toLowerCase()} ${first.desc ? "descending" : "ascending"}`;
});
</script>

<template>
  <section ref="roster" class="roster not-prose my-6" aria-label="Hosts">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>
    <header :class="ROSTER_CLASS.bar">
      <span :class="ROSTER_CLASS.title">hosts()</span>
      <span :class="ROSTER_CLASS.meta">{{ rows.length }} hosts · {{ order }}</span>
    </header>
    <div class="roster-ruler" aria-hidden="true" />
    <UTable
      v-model:sorting="sorting"
      :data="rows"
      :columns="columns"
      :get-row-id="(row) => row.key"
      :ui="ROSTER_TABLE_UI"
    >
      <template #name-header="{ column }"><RosterSort :column="column" label="Host" /></template>
      <template #adapter-header="{ column }"><RosterSort :column="column" label="Adapter" /></template>
      <template #peer-header="{ column }"><RosterSort :column="column" label="Peer" /></template>
      <template #name-cell="{ row }">
        <NuxtLink :to="row.original.to" :class="[ROSTER_CLASS.name, 'max-w-full items-baseline']">
          <UIcon :name="row.original.icon" class="relative top-0.5 size-3.5 flex-none" aria-hidden="true" />
          <span class="truncate">{{ row.original.name }}</span>
          <span :class="[ROSTER_CLASS.id, 'flex-none']">{{ row.original.key }}</span>
        </NuxtLink>
      </template>
      <template #adapter-cell="{ row }">
        <span class="whitespace-nowrap text-highlighted">{{ row.original.adapter }}</span>
      </template>
      <template #peer-cell="{ row }">
        <UTooltip :text="`${row.original.peer} ${row.original.range}`">
          <span class="block truncate text-muted" tabindex="0"
            >{{ row.original.peer }} <span class="text-dimmed">{{ row.original.range }}</span></span
          >
        </UTooltip>
      </template>
      <template #failure-cell="{ row }">
        <span :class="ROSTER_CLASS.count"
          ><span :class="ROSTER_CLASS.leader" aria-hidden="true" /><span class="min-w-0 truncate text-highlighted">{{
            row.original.failure
          }}</span></span
        >
      </template>
    </UTable>
    <footer :class="ROSTER_CLASS.footer">
      <span>peer ranges read from package.json</span>
      <span :class="ROSTER_CLASS.meta">every peer is optional</span>
    </footer>
  </section>
</template>
