import { callEveryHost, HOSTS, hostViews, problems } from "../utils/hosts";

/** The calls the landing sends to every host. Neighbours differ on purpose, so the walk shows it. */
export const CASES = [
  { label: "valid", args: { text: "Hello, Wörld!" } },
  { label: "typo", args: { text: "Hello", seperator: "_" } },
  { label: "enum", args: { text: "Hello", separator: "~" } },
  { label: "shrug", args: { text: "¯\\_(ツ)_/¯" } },
  { label: "blank", args: { text: "   " } },
] as const;

/**
 * One clock for every landing panel. The hosts and their answers come from the adapters, computed at
 * prerender and shipped in the payload, so the page never loads the MCP SDK just to show them.
 */
export function useLandingHosts() {
  const { data: views } = useAsyncData("landing-host-views", () => hostViews());
  const { data: answers } = useAsyncData("landing-host-answers", () =>
    Promise.all(CASES.map((sample) => callEveryHost(sample.args))),
  );
  const cases = CASES.map((sample) => ({ ...sample, problems: problems(sample.args) }));

  const tick = ref(0);
  const paused = ref(false);
  const hostIndex = computed(() => tick.value % HOSTS.length);
  const caseIndex = computed(() => tick.value % CASES.length);

  let timer: number | undefined;

  /** Wraps at both ends, so previous on the first sample lands on the last one. */
  function step(delta: number) {
    const span = HOSTS.length * CASES.length;
    tick.value = (tick.value + delta + span) % span;
  }

  function stopWalk() {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }

  function startWalk() {
    stopWalk();
    if (!import.meta.client || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    timer = window.setInterval(() => {
      if (!paused.value && !document.hidden) {
        step(1);
      }
    }, 4200);
  }

  onMounted(startWalk);
  onUnmounted(stopWalk);

  return { views, answers, cases, tick, paused, hostIndex, caseIndex, step };
}
