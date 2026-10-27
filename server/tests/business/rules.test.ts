import { describe, expect, it } from "vitest";
import { occurs, rotationKid } from "../../src/business/scheduling.js";
import { petLevel, rank, effectiveStreak } from "../../src/business/gamification.js";
import { validate } from "../../src/business/validation.js";
import { pythonRound } from "../../src/business/round.js";
import { businessResponse } from "../../src/business/response.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
describe("reference scheduling and business boundaries", () => {
	it.each([
		["once", "2026-10-20", null, true], ["daily", "2026-10-25", null, true],
		["weekly", "2026-10-26", null, true], ["weekly", "2026-10-27", null, false],
		["fortnightly", "2026-10-26", null, false], ["fortnightly", "2026-11-02", null, true],
		["fortnightly", "2026-10-05", null, true], ["fortnightly", "2026-10-12", null, false],
		["custom", "2026-10-20", [1, 3], true], ["custom", "2026-10-21", [1, 3], false],
		["custom", "2026-10-21", [], false], ["unknown", "2026-10-20", null, false],
	])("%s occurrence on %s", (recurrence, date, custom, expected) => {
		expect(occurs(String(recurrence), String(date), "2026-10-19T15:30:00Z", custom)).toBe(expected);
	});
	it.each([
		["2026-10-23", 0, 10], ["2026-10-24", 0, 10], ["2026-10-25", 0, 10], ["2026-10-26", 0, 20], ["2026-10-27", 0, 30], ["2026-10-28", 0, 10], ["2026-10-22", 0, 30],
	])("projects occurrence rotation on %s", (date, index, expected) => {
		expect(rotationKid({ kid_ids: [10, 20, 30], cadence: "daily", current_index: index }, String(date), "2026-10-23", [0, 1, 2, 3, 4])).toBe(expected);
	});
	it("does not project non-daily rotation advancement before the scheduler", () => {
		expect(rotationKid({ kid_ids: [10, 20], cadence: "weekly", current_index: 0 }, "2026-12-01", "2026-10-01", null)).toBe(10);
	});
	it.each([[0, 1, "Hatchling"], [49, 1, "Hatchling"], [50, 2, "Youngling"], [150, 3, "Companion"], [3500, 8, "Legendary"]])("pet XP %s", (xp, level, name) => {
		expect(petLevel(Number(xp))).toMatchObject({ level, name });
	});
	it.each([[0, "Apprentice"], [99, "Apprentice"], [100, "Scout"], [500, "Adventurer"], [20000, "Mythic"]])("rank XP %s", (xp, title) => {
		expect(rank(Number(xp)).title).toBe(title);
	});
	it.each([[.125, 2, .12], [.375, 2, .38], [2.675, 2, 2.67], [-1.25, 1, -1.2], [1.005, 2, 1], [.0005, 3, .001]])("matches Python round(%s, %s)", (value, digits, expected) => {
		expect(pythonRound(value, digits)).toBe(expected);
	});
	it("handles absent/future streak dates and overlapping vacation periods", () => {
		expect(effectiveStreak({ current_streak: 5, last_streak_date: null }, [], "2026-10-20")).toBe(0);
		expect(effectiveStreak({ current_streak: 5, last_streak_date: "2026-10-21" }, [], "2026-10-20")).toBe(5);
		expect(effectiveStreak({ current_streak: 5, last_streak_date: "2026-10-16" }, [{ start_date: "2026-10-17", end_date: "2026-10-19", is_active: true }, { start_date: "2026-10-18", end_date: "2026-10-19", is_active: true }], "2026-10-20")).toBe(5);
	});
});
describe("request validation", () => {
	it.each([
		["2030-01-02T00:00:00+02:00",true],
		["2030-01-02T00:00:00-05:00",true],
		["2030-01-02T00:00:00.000000Z",true],
		["2030-01-02T00:00:00.000001Z",false],
		["2030-01-02T01:00:00+01:00",false],
	] as const)("matches verified Pydantic date-only midnight/offset semantics (%s)",(value,valid)=>{
		if(valid)expect(validate({when:value},{when:{type:"date"}})).toEqual({when:"2030-01-02"});
		else expect(()=>validate({when:value},{when:{type:"date"}})).toThrow();
	});
	it("verifies the actual Python create/convert positive-value rules and unconstrained edit schemas without loading app configuration",async()=>{
		const repo=fileURLToPath(new URL("../../../",import.meta.url));
		const {stdout}=await promisify(execFile)(fileURLToPath(new URL("../../../.venv/Scripts/python.exe",import.meta.url)),["-c",[
			"import ast,enum,json,sys,pathlib",
			"from pydantic import BaseModel,Field,ValidationError",
			"root=pathlib.Path(sys.argv[1])",
			"def load(path,names):",
			" tree=ast.parse((root/path).read_text(encoding='utf-8'))",
			" selected=[n for n in tree.body if isinstance(n,ast.ClassDef) and n.name in names]",
			" exec(compile(ast.Module(body=selected,type_ignores=[]),'reference-fixture','exec'),globals())",
			"load('backend/models.py',{'Difficulty','Recurrence'})",
			"load('backend/schemas.py',{'ChoreCreate','ChoreUpdate','RewardCreate','RewardUpdate','WishlistConvertRequest'})",
			"out={}",
			"for name in ('ChoreCreate','ChoreUpdate','RewardCreate','RewardUpdate','WishlistConvertRequest'):",
			" out[name]=[]",
			" for price in (0,-1,7):",
			"  data={'title':'Test','points':price,'difficulty':'easy','category_id':1,'recurrence':'once'} if name.startswith('Chore') else {'title':'Test','point_cost':price}",
			"  try: globals()[name].model_validate(data);out[name].append(True)",
			"  except ValidationError: out[name].append(False)",
			"print(json.dumps(out))",
		].join("\n"),repo],{windowsHide:true});
		expect(JSON.parse(stdout)).toEqual({ChoreCreate:[false,false,true],ChoreUpdate:[true,true,true],RewardCreate:[false,false,true],RewardUpdate:[true,true,true],WishlistConvertRequest:[false,false,true]});
	});
	it("normalizes datetime offsets/epochs and preserves valid microseconds while rejecting invalid calendar days", () => {
		expect(validate({ when: "2030-01-02T03:04:05.123456+02:00" }, { when: { type: "datetime" } })).toEqual({ when: "2030-01-02T01:04:05.123456Z" });
		expect(validate({ when: 1893456000 }, { when: { type: "datetime" } })).toEqual({ when: "2030-01-01T00:00:00.000Z" });
		expect(() => validate({ when: "2030-02-30T00:00:00Z" }, { when: { type: "datetime" } })).toThrow();
	});
	it("matches Pydantic's naive UTC timestamp output without rewriting user JSON/text", () => {
		expect(businessResponse({ created_at: "2030-01-01T00:00:00.123456Z", verified_at: "2030-01-01T00:00:00.000000Z", title: "2030-01-01T00:00:00.123Z", avatar_config: { created_at: "2030-01-01T00:00:00.123Z" } })).toEqual({ created_at: "2030-01-01T00:00:00.123456", verified_at: "2030-01-01T00:00:00", title: "2030-01-01T00:00:00.123Z", avatar_config: { created_at: "2030-01-01T00:00:00.123Z" } });
	});
	it.each([null, [], "text", false, 1])("rejects malformed object body %j", value => {
		expect(() => validate(value, { title: { type: "str" } })).toThrow();
	});
	it.each(["1e2", "0x10", Infinity, NaN, 1.1, null, {}, []])("rejects invalid integer %j", value => {
		expect(() => validate({ value }, { value: { type: "int" } })).toThrow();
	});
	it("keeps optional null distinct from omitted, ignores extra ownership fields and counts Unicode codepoints", () => {
		expect(validate({ value: null, user_id: 999 }, { value: { type: "str", optional: true, nullable: true } })).toEqual({ value: null });
		expect(validate({}, { value: { type: "str", optional: true, nullable: true } })).toEqual({});
		expect(validate({ name: "😀😀" }, { name: { type: "str", max: 2 } })).toEqual({ name: "😀😀" });
	});
});
