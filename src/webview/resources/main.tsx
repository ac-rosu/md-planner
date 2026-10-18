import { render } from "preact";
import "../shared/base.css";
import { App } from "./App";
import "./resources.css";

render(<App />, document.getElementById("root")!);
