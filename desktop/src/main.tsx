import { createRoot } from "react-dom/client";
import App from "./Environments";
import { initializeAppearance } from "./appearance";
import "./styles.css";
import "./studio.css";
import "./composer.css";
import "./focus.css";
import "./composer-refinement.css";
import "./icon-refinement.css";
import "./neutral-theme.css";
import "./page-consistency.css";
import "./dialog-consistency.css";

initializeAppearance();
createRoot(document.getElementById("root")!).render(<App />);
