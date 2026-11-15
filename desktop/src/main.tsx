import { createRoot } from "react-dom/client";
import App from "./Environments";
import "./styles.css";
import "./studio.css";
import "./composer.css";
import "./focus.css";

createRoot(document.getElementById("root")!).render(<App />);
