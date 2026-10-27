import { onContentUpdated, type Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h, onMounted } from "vue";
import AgentGallery from "./components/AgentGallery.vue";
import AgentGraph from "./components/AgentGraph.vue";
import CommandMap from "./components/CommandMap.vue";
import HomeSections from "./components/HomeSections.vue";
import PmSwitch from "./components/PmSwitch.vue";
import PrincipleFlow from "./components/PrincipleFlow.vue";
import SystemDiagram from "./components/SystemDiagram.vue";
import TerminalDemo from "./components/TerminalDemo.vue";
import WorkflowDiagram from "./components/WorkflowDiagram.vue";
import { followTabClicks, loadPackageManager, showPackageManager } from "./pm.ts";
import "./style.css";

/**
 * The default VitePress theme with MetatorAI's brand, the diagrams used across the pages and a
 * package-manager switch in the navigation bar that every package-manager code group follows.
 */
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "nav-bar-content-after": () => h(PmSwitch, { variant: "select" }),
      "nav-screen-content-after": () => h(PmSwitch),
    }),
  setup() {
    onMounted(() => {
      loadPackageManager();
      followTabClicks();
      showPackageManager();
    });
    onContentUpdated(() => showPackageManager());
  },
  enhanceApp({ app }) {
    for (const [name, component] of Object.entries({
      AgentGallery,
      AgentGraph,
      CommandMap,
      HomeSections,
      PmSwitch,
      PrincipleFlow,
      SystemDiagram,
      TerminalDemo,
      WorkflowDiagram,
    }))
      app.component(name, component);
  },
} satisfies Theme;
