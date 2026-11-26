import { registerRootComponent } from "expo";
// Installed before the app loads so even startup errors reach the server log.
import { installCrashReporter } from "./src/crashReporter";

installCrashReporter();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const App = require("./App").default;

registerRootComponent(App);
