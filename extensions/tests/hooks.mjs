// Redirects the two bare imports pi normally provides to test stubs, so the
// extension file runs under plain node without any installed dependency.
const REDIRECTS = {
	typebox: new URL("./stubs/typebox.mjs", import.meta.url).href,
	"@earendil-works/pi-coding-agent": new URL("./stubs/pi-coding-agent.mjs", import.meta.url).href,
	"@earendil-works/pi-tui": new URL("./stubs/pi-tui.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, next) {
	if (specifier in REDIRECTS) {
		return { url: REDIRECTS[specifier], shortCircuit: true, format: "module" };
	}
	return next(specifier, context);
}
