// Minimal schema-builder stub: records the shape tests assert on.
const annotate = (schema, options) => {
	if (options && typeof options === "object") Object.assign(schema, options);
	return schema;
};

export const Type = {
	Object: (properties, options) => annotate({ type: "object", properties: properties ?? {} }, options),
	String: (options) => annotate({ type: "string" }, options),
	Number: (options) => annotate({ type: "number" }, options),
	Boolean: (options) => annotate({ type: "boolean" }, options),
	Optional: (schema) => {
		schema.optional = true;
		return schema;
	},
};
