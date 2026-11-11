import { onContentUpdated, type Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h, onMounted } from "vue";
import AgentGallery from "./components/AgentGallery.vue";
import PmSwitch from "./components/PmSwitch.vue";
import WorkflowDiagram from "./components/WorkflowDiagram.vue";
import { followTabClicks, loadPackageManager, showPackageManager } from "./pm.ts";
import "./style.css";

/**
 * The default VitePress theme, two tables generated from the repository (workflows, agents) and a
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
    for (const [name, component] of Object.entries({ AgentGallery, PmSwitch, WorkflowDiagram }))
      app.component(name, component);
  },
} satisfies Theme;
