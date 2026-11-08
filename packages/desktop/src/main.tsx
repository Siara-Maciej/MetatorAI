import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
