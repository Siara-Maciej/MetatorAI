import { createRoot } from "react-dom/client";
import { App } from "./app/app.tsx";
import "./ui/theme.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
