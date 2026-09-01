import ReactDOM from "react-dom/client";
import App from "./App";
import { RuntimeGate } from "./runtime/RuntimeGate";
import "./styles.css";
import "./light-theme.css";
import "./native-network.css";
import "./webmcp/approval.css";
import "./incident-decision.css";
import "./runtime/runtime.css";
import "./shift-report.css";
import "./rolling-stock-regulation.css";
import "./operational-pages.css";
import "./ux-polish.css";
import "./configuration-modal.css";
import "./passenger-flow.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <RuntimeGate>
    <App />
  </RuntimeGate>,
);
