import { render } from "preact";
import "../shared/base.css";
import { bindUndoKeys } from "../shared/vscode";
import { App } from "./App";
import "./testRunner.css";

bindUndoKeys();
render(<App />, document.getElementById("root")!);
