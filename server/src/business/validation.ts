import { BusinessError, type Row } from "./store.js";
export interface Rule {
	type: "str" | "int" | "float" | "bool" | "date" | "datetime" | "dict" | "list";
	optional?: boolean;
	nullable?: boolean;
	default?: unknown;
	min?: number;
	max?: number;
	gt?: number;
	choices?: readonly string[];
	pattern?: string;
	item?: Rule;
	fields?: Rules;
}
export type Rules = Record<string, Rule>;
export const str = (max?: number): Rule => ({ type: "str", max });
export const int = (gt?: number): Rule => ({ type: "int", gt });
export const optional = (rule: Rule): Rule => ({ ...rule, optional: true, nullable: true });
export const recurrence: Rule = { type: "str", choices: ["once", "daily", "weekly", "fortnightly", "custom"] };
export const cadence: Rule = { type: "str", choices: ["daily", "weekly", "fortnightly", "monthly"] };
export const difficulty: Rule = { type: "str", choices: ["easy", "medium", "hard", "expert"] };
export const ids: Rule = { type: "list", item: int() };
export function validate(value: unknown, rules: Rules, source = "body"): Row {
	const errors: unknown[] = [];
	function parse(value: unknown, rule: Rule, loc: Array<string | number>): unknown {
		const fail = (type: string, msg: string, ctx?: Row) => { errors.push({ type, loc, msg, ...(ctx ? { ctx } : {}) }); return undefined; };
		if (value === undefined)
			return "default" in rule ? rule.default : rule.optional ? undefined : fail("missing", "Field required");
		if (value === null && rule.nullable)
			return null;
		let parsed: unknown = value;
		switch (rule.type) {
			case "str":
				if (typeof value !== "string")
					return fail("string_type", "Input should be a valid string");
				break;
			case "int":
			case "float": {
				const numeric = rule.type === "int" ? /^\s*[+-]?\d+(?:\.0+)?\s*$/ : /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i;
				parsed = typeof value === "boolean" ? Number(value) : typeof value === "string" && numeric.test(value) ? Number(value) : value;
				if (typeof parsed !== "number" || !Number.isFinite(parsed) || (rule.type === "int" && !Number.isSafeInteger(parsed)))
					return fail(`${rule.type}_parsing`, `Input should be a valid ${rule.type === "int" ? "integer" : "number"}`);
				break;
			}
			case "bool": {
				const v = typeof value === "string" ? value.toLowerCase() : value;
				if ([true, 1, "true", "1", "yes", "on", "y", "t"].includes(v as string))
					parsed = true;
				else if ([false, 0, "false", "0", "no", "off", "n", "f"].includes(v as string))
					parsed = false;
				else
					return fail("bool_parsing", "Input should be a valid boolean");
				break;
			}
			case "dict":
				if (typeof value !== "object" || value === null || Array.isArray(value))
					return fail("dict_type", "Input should be a valid dictionary");
				if (rule.fields)
					parsed = parseFields(value as Row, rule.fields, loc);
				break;
			case "list":
				if (!Array.isArray(value))
					return fail("list_type", "Input should be a valid list");
				parsed = value.map((v, i) => rule.item ? parse(v, rule.item, [...loc, i]) : v);
				break;
			case "date":
			case "datetime": {
				const numeric = typeof value === "number" || (typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value));
				let date: Date;
				if (numeric) {
					const timestamp = Number(value);
					date = new Date(Math.abs(timestamp) <= 20000000000 ? timestamp * 1000 : timestamp);
				}
				else if (typeof value === "string" && /^\d{4}-\d\d-\d\d(?:$|[Tt ]\d\d:\d\d(?::\d\d(?:\.\d{1,6})?)?(?:[Zz]|[+-]\d\d:?\d\d)?)$/.test(value)) {
					const calendar = value.slice(0, 10), check = new Date(`${calendar}T00:00:00Z`);
					if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 10) !== calendar)
						return fail("date_from_datetime_parsing", "Input should be a valid date or datetime");
					const clock = /[Tt ](\d\d):(\d\d)(?::(\d\d))?/.exec(value);
					if (clock && (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] ?? 0) > 59))
						return fail("date_from_datetime_parsing", "Input should be a valid date or datetime");
					const normalized = value.replace(" ", "T").replace("t", "T");
					date = new Date(value.length === 10 ? `${value}T00:00:00Z` : /(?:[Zz]|[+-]\d\d:?\d\d)$/.test(normalized) ? normalized : `${normalized}Z`);
				}
				else
					return fail("date_from_datetime_parsing", "Input should be a valid date or datetime");
				if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
					return fail("date_from_datetime_parsing", "Input should be a valid date or datetime");
				if (rule.type === "date") {
					if (date.getUTCHours() || date.getUTCMinutes() || date.getUTCSeconds() || date.getUTCMilliseconds())
						return fail("date_from_datetime_inexact", "Datetimes provided to dates should have zero time - e.g. be exact dates");
					parsed = date.toISOString().slice(0, 10);
				}
				else {
					const fraction = typeof value === "string" && !numeric ? /\.(\d{1,6})(?:[Zz]|[+-]\d\d:?\d\d)?$/.exec(value)?.[1] : undefined;
					parsed = fraction ? date.toISOString().replace(/\.\d{3}Z$/, `.${fraction.padEnd(6, "0")}Z`) : date.toISOString();
				}
				break;
			}
		}
		if (rule.choices && !rule.choices.includes(parsed as string))
			return fail("enum", `Input should be ${rule.choices.map(c => `'${c}'`).join(" or ")}`, { expected: rule.choices.join(", ") });
		if (rule.pattern && typeof parsed === "string" && !new RegExp(rule.pattern).test(parsed))
			return fail("string_pattern_mismatch", `String should match pattern '${rule.pattern}'`, { pattern: rule.pattern });
		const size = typeof parsed === "string" ? [...parsed].length : Number(parsed);
		if (rule.min !== undefined && size < rule.min)
			return fail("greater_than_equal", `Input should be greater than or equal to ${rule.min}`, { ge: rule.min });
		if (rule.max !== undefined && size > rule.max)
			return fail(typeof parsed === "string" ? "string_too_long" : "less_than_equal", typeof parsed === "string" ? `String should have at most ${rule.max} characters` : `Input should be less than or equal to ${rule.max}`, typeof parsed === "string" ? { max_length: rule.max } : { le: rule.max });
		if (rule.gt !== undefined && size <= rule.gt)
			return fail("greater_than", `Input should be greater than ${rule.gt}`, { gt: rule.gt });
		return parsed;
	}
	function parseFields(value: Row, fields: Rules, loc: Array<string | number>): Row {
		return Object.fromEntries(Object.entries(fields).flatMap(([key, rule]) => {
			const result = parse(value[key], rule, [...loc, key]);
			return result === undefined ? [] : [[key, result]];
		}));
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new BusinessError(422, [{ type: "model_attributes_type", loc: [source], msg: "Input should be a valid dictionary or object to extract fields from" }]);
	const result = parseFields(value as Row, rules, [source]);
	if (errors.length)
		throw new BusinessError(422, errors);
	return result;
}
