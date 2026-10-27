import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import AgentGallery from "./components/AgentGallery.vue";
import AgentGraph from "./components/AgentGraph.vue";
import CommandMap from "./components/CommandMap.vue";
import HomeSections from "./components/HomeSections.vue";
import PrincipleFlow from "./components/PrincipleFlow.vue";
import SystemDiagram from "./components/SystemDiagram.vue";
import TerminalDemo from "./components/TerminalDemo.vue";
import WorkflowDiagram from "./components/WorkflowDiagram.vue";
import "./style.css";

/** The default VitePress theme with MetatorAI's brand and the diagrams used across the pages. */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    for (const [name, component] of Object.entries({
      AgentGallery,
      AgentGraph,
      CommandMap,
      HomeSections,
      PrincipleFlow,
      SystemDiagram,
      TerminalDemo,
      WorkflowDiagram,
    }))
      app.component(name, component);
  },
} satisfies Theme;
