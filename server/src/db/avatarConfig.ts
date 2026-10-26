/** Shared boundary for both avatar save and Phase 3 profile updates. A client
 * may customize appearance, but cannot overwrite progression or daily budget. */
export function mergeAvatarConfig(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
	const config = { ...incoming };
	for (const key of ["pet_xp_map", "pet_xp", "pet_interactions"]) {
		delete config[key];
		if (key in existing)
			config[key] = existing[key];
	}
	const stored = existing.pet_xp_map;
	const map = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? { ...stored } as Record<string, unknown> : {};
	if (!stored && existing.pet && existing.pet !== "none" && Number(existing.pet_xp) > 0) {
		map[String(existing.pet)] = existing.pet_xp;
		config.pet_xp_map = map;
	}
	if (config.pet && config.pet !== "none")
		config.pet_xp = map[String(config.pet)] ?? 0;
	return config;
}
