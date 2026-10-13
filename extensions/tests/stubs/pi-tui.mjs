// Stub of the pi-tui component surface the extension imports. Tests never
// render, so the components are inert shapes only.
export class Box {
	constructor(_paddingX, _paddingY, _bgFn) {}
	addChild(_child) {}
	render() {
		return [];
	}
	invalidate() {}
}

export class Text {
	constructor(_content, _paddingX, _paddingY, _bgFn) {}
	setText(_text) {}
	render() {
		return [];
	}
	invalidate() {}
}
