import { render } from "preact";
import { App } from "./app/App.tsx";
import "./styles.css";

// Android mirrors its layout for a right-to-left language, even with English
// wording; the browser's preferred language decides here.
const rtl = /^(ar|fa|he|iw|ur|ps|sd|ug|yi|ckb|dv)(-|$)/i.test(navigator.language ?? "");
document.documentElement.dir = rtl ? "rtl" : "ltr";

render(<App />, document.getElementById("app")!);
