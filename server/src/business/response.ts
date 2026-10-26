const timestamps = new Set(["created_at", "updated_at", "completed_at", "verified_at", "approved_at", "fulfilled_at", "unlocked_at", "last_rotated", "start_date", "end_date", "timestamp"]);
const jsonFields = new Set(["avatar_config", "config", "criteria", "details", "settings"]);
/** SQLAlchemy reloads SQLite datetimes as naive UTC. Pydantic emits six
 * fractional digits when nonzero and no timezone suffix for those values.
 * Keep internal UTC timestamps explicit, converting only response date fields.
 * User-provided JSON and ordinary text must never be rewritten heuristically. */
export function businessResponse(value: unknown, field = ""): unknown {
	if (jsonFields.has(field))
		return value;
	if (timestamps.has(field) && typeof value === "string") {
		const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(value);
		if (match) {
			const fraction = (match[2] ?? "").padEnd(6, "0");
			return match[1] + (Number(fraction) ? `.${fraction}` : "");
		}
	}
	if (Array.isArray(value))
		return value.map(entry => businessResponse(entry));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, businessResponse(entry, key)]));
	return value;
}
