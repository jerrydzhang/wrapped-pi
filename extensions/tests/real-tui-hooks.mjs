// Used only by the inspector runtime tests: resolve Pi's actual pinned TUI,
// without installing packages or replacing any SDK/runtime implementation.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
let modules;
export function initialize(data) { modules = data.modules; }
export async function resolve(specifier, context, next) {
	if (specifier === "@earendil-works/pi-tui") {
		return { url: pathToFileURL(join(modules, "@earendil-works/pi-tui/dist/index.js")).href, shortCircuit: true };
	}
	return next(specifier, context);
}
