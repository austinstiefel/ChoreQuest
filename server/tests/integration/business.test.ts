import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../../src/app.js";
import { newUserData } from "../../src/auth/accounts.js";
import { createAccessToken } from "../../src/auth/tokens.js";
import { loadAuthConfig } from "../../src/config/auth.js";
import { createBusinessRouter } from "../../src/business/index.js";
import { UploadStorage } from "../../src/business/uploads.js";
import { Store, day, addDays, monday, type Row } from "../../src/business/store.js";
import { effectiveStreak, advanceStreak } from "../../src/business/gamification.js";
import type { Rules, Rule } from "../../src/business/validation.js";
import { createAdminRouter, createPrismaAdminRepository } from "../../src/routes/admin.js";
import { createPrismaAuthRepository, createAuthRouter } from "../../src/routes/auth.js";
import { seedBusinessData } from "../../src/business/seed.js";
import { disposableDatabase } from "../helpers/sqlite.js";
import { PNG } from "../helpers/images.js";
const config = loadAuthConfig({ SECRET_KEY: "phase-four-fixture-secret-only" });
let db: Awaited<ReturnType<typeof disposableDatabase>>, store: Store, api: Awaited<ReturnType<typeof createBusinessRouter>>, app: ReturnType<typeof createApp>;
let admin: number, parent: number, kid: number, other: number, tokens: Record<string, string>, category: number;
let uploads:UploadStorage;
beforeEach(async () => {
	db = await disposableDatabase();
	store = await Store.open(db.prisma);
	const users = [];
	for (const [username, role] of [["Admin", "admin"], ["Parent", "parent"], ["Kid", "kid"], ["Other", "kid"]])
		users.push(await db.prisma.users.create({ data: newUserData({ username, role, displayName: username, passwordHash: "unusable-test-only" }) }));
	[admin, parent, kid, other] = users.map(u => u.id);
	tokens = {};
	for (const u of users)
		tokens[u.id] = `Bearer ${await createAccessToken(u.id, u.role, config)}`;
	category = Number((await store.insert("chore_categories", { name: "General", icon: "home", colour: "#123456", is_default: false })).id);
	uploads = new UploadStorage(resolve(db.directory,"uploads"));
	api = await createBusinessRouter(db.prisma, config, uploads);
	const auth = createPrismaAuthRepository(db.prisma);
	app = createApp(createAuthRouter({ config, repository: auth }), config, createAdminRouter({ config, auth, repository: createPrismaAdminRepository(db.prisma) }), api.router);
});
afterEach(async () => { vi.restoreAllMocks(); await db.dispose(); });
const req = (method: "get" | "post" | "put" | "delete", path: string, uid = parent) => request(app)[method](path).set("Authorization", tokens[uid]);
const makeChore = async (extra: Row = {}) => {
	const response = await req("post", "/api/chores").send({ title: "Dishes", points: 10, difficulty: "easy", category_id: category, recurrence: "daily", ...extra }).expect(201);
	return response.body as Row;
};
const assign = async (cid: unknown, uid = kid) => req("post", `/api/chores/${cid}/assign`).send({ assignments: [{ user_id: uid, recurrence: "daily" }] }).expect(201);
function sampleRule(rule: Rule): unknown {
	if ("default" in rule && rule.default !== undefined)
		return rule.default;
	if (rule.choices)
		return rule.choices[0];
	switch (rule.type) {
		case "str": return "test";
		case "int":
		case "float": return Math.max(2, (rule.gt ?? 0) + 1, rule.min ?? 0);
		case "bool": return false;
		case "date": return day();
		case "datetime": return new Date().toISOString();
		case "dict": return rule.fields ? sampleBody(rule.fields) : {};
		case "list": return [];
	}
}
function sampleBody(rules: Rules): Row { return Object.fromEntries(Object.entries(rules).filter(([, v]) => !v.optional).map(([k, v]) => [k, sampleRule(v)])); }
describe("complete Python route inventory and guards", () => {
	it("accounts for every Python business REST path, method and role", async () => {
		const directory = new URL("../../../backend/routers/", import.meta.url), found = [];
		for (const name of await readdir(directory)) {
			if (!name.endsWith(".py") || name === "auth.py")
				continue;
			const text = await readFile(new URL(name, directory), "utf8"), prefix = /APIRouter\(prefix="([^"]+)"/.exec(text)?.[1];
			for (const match of text.matchAll(/@router\.(get|post|put|delete)\("([^"]*)"[^\n]*\)\s*async def (\w+)\(([\s\S]*?)\):/g)) {
				if (name === "admin.py" && !match[2].startsWith("/settings"))
					continue;
				const path = (prefix + match[2]).replace(/\{(\w+)\}/g, ":$1"), role = match[4].includes("Depends(require_admin)") ? "admin" : match[4].includes("Depends(require_parent)") ? "parent" : match[4].includes("Depends(get_current_user)") ? "authenticated" : "public";
				found.push(`${match[1]} ${path}`);
				const endpoint = api.routes.find(e => e.method === match[1] && e.path === path);
				expect(endpoint, `${name}:${match[3]}`).toBeDefined();
				expect(endpoint?.role, `${match[1]} ${path}`).toBe(role);
				expect(endpoint?.status ?? 200, `${match[1]} ${path} success status`).toBe(Number(/status_code=(\d+)/.exec(match[0])?.[1] ?? 200));
			}
		}
		expect(found.length).toBeGreaterThan(90);
		expect(new Set(found).size + 3).toBe(api.routes.length); // secure assignment-specific aliases for the existing frontend
	});
	it("rejects unauthenticated requests at every protected endpoint", async () => {
		for (const route of api.routes.filter(e => e.role !== "public")) {
			const path = route.path.replace(/:\w+/g, "1");
			const response = await request(app)[route.method](path).send({});
			expect(response.status, `${route.method} ${path}`).toBe(401);
		}
	});
	it("enforces parent/admin roles before resource lookup at every privileged endpoint", async () => {
		for (const route of api.routes.filter(e => ["parent", "admin"].includes(e.role))) {
			const path = route.path.replace(/:\w+/g, "99999");
			expect((await req(route.method, path, kid).send({})).status, `${route.method} ${path}`).toBe(403);
			if (route.role === "admin")
				expect((await req(route.method, path, parent).send({})).status).toBe(403);
		}
	});
	it("returns FastAPI-style 422 details for malformed bodies on every schema-validated endpoint", async () => {
		for (const route of api.routes.filter(e => e.rules)) {
			const path = route.path.replace(/:\w+/g, "1"), response = await req(route.method, path, admin).set("Content-Type", "application/json").send("null");
			expect(response.status, `${route.method} ${path}`).toBe(422);
			expect(response.body.detail[0]).toHaveProperty("loc");
		}
	});
	it("validates path IDs before using them in database queries", async () => {
		for (const route of api.routes.filter(e => e.path.includes(":") && !e.path.includes(":filename"))) {
			const response = await req(route.method, route.path.replace(/:\w+/g, "not-a-number"), admin).send(route.rules ? sampleBody(route.rules) : {});
			expect(response.status, `${route.method} ${route.path}`).toBe(422);
		}
	});
});
describe("chore and calendar lifecycle", () => {
	it("creates, completes, approves once, stacks events, unlocks achievements and preserves history on delete", async () => {
		vi.spyOn(Math, "random").mockReturnValue(.99);
		const a = await store.insert("achievements", { key: "first", title: "First", description: "One quest", icon: "star", points_reward: 3, criteria: { type: "total_completions", count: 1 }, tier: "bronze", group_key: null, sort_order: 1 });
		const c = await makeChore();
		await assign(c.id);
		await req("post", "/api/events").send({ title: "Double", multiplier: 2, start_date: new Date(Date.now() - 10000).toISOString(), end_date: new Date(Date.now() + 86400000).toISOString() }).expect(201);
		await req("post", `/api/chores/${c.id}/complete`, kid).expect(200);
		expect((await store.one("users", kid, "User")).points_balance).toBe(0);
		const results = await Promise.all([req("post", `/api/chores/${c.id}/verify`), req("post", `/api/chores/${c.id}/verify`)]);
		expect(results.map(r => r.status).sort()).toEqual([200, 404]);
		const user = await store.one("users", kid, "User");
		expect(user).toMatchObject({ points_balance: 23, total_points_earned: 23, current_streak: 1, last_streak_date: day() });
		expect(await db.prisma.user_achievements.count()).toBe(1);
		expect(await db.prisma.point_transactions.count()).toBe(3);
		await assign(c.id);
		expect((await store.rows("chore_assignments"))[0].status).toBe("verified");
		await req("post", `/api/chores/${c.id}/uncomplete`).expect(200);
		expect((await store.one("users", kid, "User"))).toMatchObject({ points_balance: 3, total_points_earned: 23 });
		await req("delete", `/api/chores/${c.id}`).expect(204);
		expect(await db.prisma.chore_assignments.count()).toBe(1);
		expect(await db.prisma.user_achievements.count()).toBe(1);
		await req("get", `/api/stats/achievements/${a.id}/badge`, kid).expect("Content-Type", /image\/svg\+xml/).expect(200);
		expect(await db.prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
	});
	it("rolls back verification, points and unlocks if a notification write fails", async () => {
		const c = await makeChore();
		await assign(c.id);
		await req("post", `/api/chores/${c.id}/complete`, kid).expect(200);
		await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'private fixture detail'); END");
		const response = await req("post", `/api/chores/${c.id}/verify`).expect(500);
		expect(JSON.stringify(response.body)).not.toContain("private fixture");
		expect((await store.rows("chore_assignments"))[0].status).toBe("completed");
		expect(await db.prisma.point_transactions.count()).toBe(0);
		expect((await store.one("users", kid, "User")).points_balance).toBe(0);
	});
	it("generates a week idempotently and honors removals, vacations and weekday schedules", async () => {
		const c = await makeChore();
		await assign(c.id);
		const start = monday(addDays(day(), 14));
		const first = await req("get", `/api/calendar?week_start=${start}`, kid).expect(200);
		expect(Object.keys(first.body.days)).toHaveLength(7);
		const count = await db.prisma.chore_assignments.count();
		await req("get", `/api/calendar?week_start=${start}`).expect(200);
		expect(await db.prisma.chore_assignments.count()).toBe(count);
		const slot = first.body.days[start][0];
		await req("delete", `/api/calendar/assignments/${slot.id}`).expect(204);
		const regenerated = await req("get", `/api/calendar?week_start=${start}`).expect(200);
		expect(regenerated.body.days[start]).toEqual([]);
		await req("post", "/api/vacation").send({ start_date: addDays(start, 1), end_date: addDays(start, 2) }).expect(201);
		const next = monday(addDays(start, 7));
		await req("post", "/api/vacation").send({ start_date: next, end_date: addDays(next, 6) }).expect(201);
		const empty = await req("get", `/api/calendar?week_start=${next}`).expect(200);
		expect(Object.values(empty.body.days).flat()).toEqual([]);
		await req("get", `/api/calendar?week_start=${addDays(start, 1)}`).expect(400);
		await req("get", "/api/calendar?week_start=2025-02-30").expect(422);
	});
	it("enforces ownership on completion and recipient-only one-time trade decisions", async () => {
		const c = await makeChore();
		await assign(c.id);
		const slot = (await store.rows("chore_assignments"))[0];
		await req("post", `/api/chores/${c.id}/complete`, other).expect(404);
		await req("post", "/api/calendar/trade", other).send({ assignment_id: slot.id, target_user_id: kid }).expect(403);
		const proposal = await req("post", "/api/calendar/trade", kid).send({ assignment_id: slot.id, target_user_id: other }).expect(200);
		await req("post", `/api/calendar/trade/${proposal.body.notification_id}/accept`, kid).expect(404);
		await req("post", `/api/calendar/trade/${proposal.body.notification_id}/accept`, other).expect(200);
		await req("post", `/api/calendar/trade/${proposal.body.notification_id}/accept`, other).expect(404);
		expect((await store.one("chore_assignments", Number(slot.id), "Assignment")).user_id).toBe(other);
	});
	it("notifies the original trade owner, transfers only to the recipient, and invalidates competing/replayed decisions",async()=>{
		const third=await db.prisma.users.create({data:newUserData({username:"Third",displayName:"Third",role:"kid",passwordHash:"test-only"})});
		tokens[third.id]=`Bearer ${await createAccessToken(third.id,"kid",config)}`;
		const c=await makeChore();await assign(c.id);const a=(await store.rows("chore_assignments"))[0];
		const first=await req("post","/api/calendar/trade",kid).send({assignment_id:a.id,target_user_id:other}).expect(200);
		const competing=await req("post","/api/calendar/trade",kid).send({assignment_id:a.id,target_user_id:third.id}).expect(200);
		await req("post",`/api/calendar/trade/${first.body.notification_id}/accept`,other).expect(200);
		expect((await store.one("chore_assignments",Number(a.id),"Assignment")).user_id).toBe(other);
		const notices=(await store.rows("notifications")).filter(n=>n.type==="trade_accepted");
		expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({user_id:kid,reference_id:a.id,reference_type:"trade",message:"Other accepted your trade for 'Dishes'."});
		for(const action of ["accept","deny"]){
			await req("post",`/api/calendar/trade/${first.body.notification_id}/${action}`,other).expect(404);
			await req("post",`/api/calendar/trade/${competing.body.notification_id}/${action}`,third.id).expect(404);
		}
		expect((await store.one("notifications",competing.body.notification_id,"Notification")).is_read).toBe(true);
		expect((await store.rows("notifications")).filter(n=>["trade_accepted","trade_denied"].includes(String(n.type)))).toHaveLength(1);
		expect((await store.one("chore_assignments",Number(a.id),"Assignment")).user_id).toBe(other);
	});
	it("notifies the original owner of denial exactly once without transferring ownership",async()=>{
		const c=await makeChore();await assign(c.id);const a=(await store.rows("chore_assignments"))[0];
		const proposal=await req("post","/api/calendar/trade",kid).send({assignment_id:a.id,target_user_id:other}).expect(200);
		await req("post",`/api/calendar/trade/${proposal.body.notification_id}/deny`,other).expect(200);
		for(const action of ["deny","accept"]) await req("post",`/api/calendar/trade/${proposal.body.notification_id}/${action}`,other).expect(404);
		expect((await store.one("chore_assignments",Number(a.id),"Assignment")).user_id).toBe(kid);
		const notices=(await store.rows("notifications")).filter(n=>n.type==="trade_denied");
		expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({user_id:kid,reference_id:a.id});
	});
	it("saves multipart proof, serves it publicly and restricts deletion to parents", async () => {
		const c = await makeChore({ requires_photo: true, assigned_user_ids: [kid] });
		await req("post", `/api/chores/${c.id}/complete`, kid).expect(400);
		const response = await req("post", `/api/chores/${c.id}/complete`, kid).attach("file", PNG, { filename: "proof.png", contentType: "image/png" }).expect(200);
		const file = response.body.photo_proof_path;
		expect(file).toMatch(/^[a-f0-9]{32}\.png$/);
		await request(app).get(`/api/uploads/${file}`).expect(200);
		await req("delete", `/api/uploads/${file}`, kid).expect(403);
		await req("delete", `/api/uploads/${file}`).expect(200);
		await request(app).get(`/api/uploads/${file}`).expect(404);
		await req("post", "/api/uploads", kid).attach("file", Buffer.from("test"), { filename: "x.txt", contentType: "text/plain" }).expect(400);
		const pending=await makeChore({title:"Proof rollback",requires_photo:true,assigned_user_ids:[kid]});
		await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_proof_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'fixture'); END");
		await req("post",`/api/chores/${pending.id}/complete`,kid).attach("file",PNG,{filename:"proof.png",contentType:"image/png"}).expect(500);
		expect(await readdir(resolve(db.directory,"uploads"))).toEqual([]);
		expect((await store.rows("chore_assignments")).find(a=>a.chore_id===pending.id)).toMatchObject({status:"pending",photo_proof_path:null});
	});
	it("rejects spoofed/malformed/oversized HTTP uploads before saving or completing a chore",async()=>{
		const c=await makeChore({requires_photo:true,assigned_user_ids:[kid]});
		for(const contents of [Buffer.from("<html>spoof</html>"),PNG.subarray(0,50)]) {
			await req("post","/api/uploads",kid).attach("file",contents,{filename:"fake.png",contentType:"image/png"}).expect(400);
			await req("post",`/api/chores/${c.id}/complete`,kid).attach("file",contents,{filename:"fake.png",contentType:"image/png"}).expect(400);
		}
		await req("post","/api/uploads",kid).attach("file",Buffer.alloc(5*1024*1024+1),{filename:"large.png",contentType:"image/png"}).expect(400);
		expect((await store.rows("chore_assignments"))[0]).toMatchObject({status:"pending",photo_proof_path:null});
		await expect(readdir(uploads.directory)).rejects.toMatchObject({code:"ENOENT"});
		const valid=await req("post","/api/uploads",kid).attach("file",PNG,{filename:"unsafe.svg",contentType:"image/png"}).expect(200);
		expect(valid.body.filename).toMatch(/^[a-f0-9]{32}\.png$/);await request(app).get(valid.body.path).expect(200);
	});
	it("reports a failed rollback cleanup without masking the database failure or leaking details",async()=>{
		const c=await makeChore({requires_photo:true,assigned_user_ids:[kid]});
		await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_cleanup_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'private fixture'); END");
		vi.spyOn(uploads,"discard").mockRejectedValueOnce(new Error("test-only private filesystem detail"));
		const warning=vi.spyOn(console,"warn").mockImplementation(()=>undefined);
		const response=await req("post",`/api/chores/${c.id}/complete`,kid).attach("file",PNG,{filename:"photo.png",contentType:"image/png"}).expect(500);
		expect((await store.rows("chore_assignments"))[0]).toMatchObject({status:"pending",photo_proof_path:null});
		expect(warning).toHaveBeenCalledOnce();expect(JSON.stringify(warning.mock.calls)).not.toContain("private");expect(JSON.stringify(response.body)).not.toContain("private");
		expect(await readdir(uploads.directory)).toHaveLength(1); // isolated orphan is removed with the disposable test directory
	});
});
describe("rewards, ownership and balances", () => {
	it.each([0,-1,7])("applies one positive-price contract to creation, editing, wishlist conversion and redemption (%s)",async price=>{
		const expected=price>0?201:422;
		const created=await req("post","/api/rewards").send({title:`Price ${price}`,point_cost:price}).expect(expected);
		const original=await req("post","/api/rewards").send({title:"Existing reward",point_cost:5}).expect(201);
		await req("put",`/api/rewards/${original.body.id}`).send({point_cost:price}).expect(price>0?200:422);
		expect((await store.one("rewards",original.body.id,"Reward")).point_cost).toBe(price>0?price:5);
		const wish=await req("post","/api/wishlist",kid).send({title:"Priced wish"}).expect(201);
		const converted=await req("post",`/api/wishlist/${wish.body.id}/convert`).send({point_cost:price}).expect(price>0?200:422);
		expect(await db.prisma.wishlist_items.count()).toBe(price>0?0:1);
		if(price>0){
			await store.update("users",kid,{points_balance:100});
			for(const rid of [created.body.id,original.body.id,converted.body.id]) await req("post",`/api/rewards/${rid}/redeem`,kid).expect(200);
			expect((await store.one("users",kid,"User")).points_balance).toBe(100-price*3);
		} else {
			// Legacy rows can contain values accepted by Python's unconstrained
			// edit schema. Reject them safely rather than minting points.
			await store.update("rewards",original.body.id,{point_cost:price,stock:1});
			await req("post",`/api/rewards/${original.body.id}/redeem`,kid).expect(400);
			expect((await store.one("users",kid,"User")).points_balance).toBe(0);
			expect((await store.one("rewards",original.body.id,"Reward")).stock).toBe(1);
			expect(await db.prisma.reward_redemptions.count()).toBe(0);
		}
	});
	it.each([0,-1,7])("matches Python's positive chore creation rule and retains it for edits (%s)",async value=>{
		const body={title:"Point policy",points:value,difficulty:"easy",category_id:category,recurrence:"once",assigned_user_ids:[kid]};
		const created=await req("post","/api/chores").send(body).expect(value>0?201:422);
		const original=await makeChore();
		await req("put",`/api/chores/${original.id}`).send({points:value}).expect(value>0?200:422);
		expect((await store.one("chores",Number(original.id),"Chore")).points).toBe(value>0?value:10);
		if(value>0){
			vi.spyOn(Math,"random").mockReturnValue(.99);
			await req("post",`/api/chores/${created.body.id}/complete`,kid).expect(200);
			await req("post",`/api/chores/${created.body.id}/verify`).expect(200);
			expect((await store.one("users",kid,"User")).points_balance).toBe(value);
		}
	});
	it("serializes redemption across independent Prisma connections", async () => {
		await store.update("users", kid, { points_balance: 40 });
		const reward = await req("post", "/api/rewards").send({ title: "One prize", point_cost: 30, stock: 1 }).expect(201);
		const second = new PrismaClient({ datasources: { db: { url: `file:${db.databasePath.replaceAll("\\", "/")}?connection_limit=1` } } });
		try {
			const secondApi = await createBusinessRouter(second, config, new UploadStorage(resolve(db.directory, "uploads"))), secondApp = createApp(undefined, config, undefined, secondApi.router);
			const results = await Promise.all([req("post", `/api/rewards/${reward.body.id}/redeem`, kid), request(secondApp).post(`/api/rewards/${reward.body.id}/redeem`).set("Authorization", tokens[kid])]);
			expect(results.map(r => r.status).sort()).toEqual([200, 400]);
			expect((await store.one("users", kid, "User")).points_balance).toBe(10);
			expect(await db.prisma.reward_redemptions.count()).toBe(1);
			expect(await db.prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
		}
		finally {
			await second.$disconnect();
		}
	});
	it("serializes limited-stock redemptions, preserves nested contracts and fulfills once", async () => {
		await req("post", `/api/points/${kid}/bonus`).send({ amount: 40, description: "Good job" }).expect(200);
		const reward = await req("post", "/api/rewards").send({ title: "Treat", point_cost: 30, stock: 1 }).expect(201);
		const results = await Promise.all([req("post", `/api/rewards/${reward.body.id}/redeem`, kid), req("post", `/api/rewards/${reward.body.id}/redeem`, kid)]);
		expect(results.map(r => r.status).sort()).toEqual([200, 400]);
		const redemption = results.find(r => r.status === 200)!.body;
		expect(redemption).toMatchObject({ status: "approved", points_spent: 30, reward: { title: "Treat", stock: 0 }, user: { id: kid, points_balance: 10 } });
		expect(JSON.stringify(redemption)).not.toContain("password_hash");
		await req("post", `/api/rewards/redemptions/${redemption.id}/fulfill`).expect(200);
		await req("post", `/api/rewards/redemptions/${redemption.id}/fulfill`).expect(400);
		await req("delete", `/api/rewards/${reward.body.id}`).expect(204);
		expect(await db.prisma.reward_redemptions.count()).toBe(1);
		const own = await req("get", "/api/rewards/redemptions", kid).expect(200);
		expect(own.body).toHaveLength(1);
		await req("get", "/api/rewards/redemptions", other).expect(200, []);
		await req("post", `/api/points/adjust/${kid}`, parent).send({ amount: 1, description: "No" }).expect(403);
		await req("post", `/api/points/adjust/${kid}`, admin).send({ amount: -11, description: "No" }).expect(400);
		expect((await store.one("users", kid, "User")).points_balance).toBe(10);
	});
	it("refunds a pending denial only once and rolls back a failed redemption", async () => {
		const reward = await req("post", "/api/rewards").send({ title: "Toy", point_cost: 20, stock: 2 }).expect(201);
		const pending = await store.insert("reward_redemptions", { reward_id: reward.body.id, user_id: kid, points_spent: 20, status: "pending", approved_by: null, approved_at: null, fulfilled_by: null, fulfilled_at: null });
		const results = await Promise.all([req("post", `/api/rewards/redemptions/${pending.id}/deny`), req("post", `/api/rewards/redemptions/${pending.id}/deny`)]);
		expect(results.map(r => r.status).sort()).toEqual([200, 400]);
		expect((await store.one("users", kid, "User")).points_balance).toBe(20);
		await db.prisma.$executeRawUnsafe("CREATE TRIGGER fail_redemption BEFORE INSERT ON reward_redemptions BEGIN SELECT RAISE(ABORT, 'fixture'); END");
		await req("post", `/api/rewards/${reward.body.id}/redeem`, kid).expect(500);
		expect((await store.one("users", kid, "User")).points_balance).toBe(20);
		expect((await store.one("rewards", reward.body.id, "Reward")).stock).toBe(2);
		expect(await db.prisma.point_transactions.count()).toBe(1);
	});
	it("keeps wishes and notifications private, converts atomically and permits parent deletion", async () => {
		const wish = await req("post", "/api/wishlist", kid).send({ title: "Bike", notes: "Blue" }).expect(201);
		await req("get", "/api/wishlist", other).expect(200, []);
		await req("put", `/api/wishlist/${wish.body.id}`, parent).send({ title: "Wrong" }).expect(403);
		await req("delete", `/api/wishlist/${wish.body.id}`, other).expect(403);
		const converted = await req("post", `/api/wishlist/${wish.body.id}/convert`).send({ point_cost: 50 }).expect(200);
		expect(converted.body).toMatchObject({ title: "Bike", description: "Blue", point_cost: 50, stock: 1 });
		expect(await db.prisma.wishlist_items.count()).toBe(0);
		const n = await store.insert("notifications", { user_id: kid, type: "bonus_points", title: "Test", message: "Test", is_read: false, reference_id: null, reference_type: null });
		await req("post", `/api/notifications/${n.id}/read`, other).expect(403);
		await req("get", "/api/notifications/unread-count", kid).expect(200, { count: 1 });
		await req("post", "/api/notifications/read-all", kid).expect(200);
		await req("get", "/api/notifications/unread-count", kid).expect(200, { count: 0 });
		await req("get", `/api/points/${kid}`, other).expect(403);
		await req("get", `/api/stats/history/${kid}`, other).expect(403);
	});
});
describe("gamification, settings and reporting", () => {
	it("seeds the built-in catalogue idempotently without overwriting credentials, rewards or schedules", async () => {
		const before = await store.one("users", admin, "User");
		await seedBusinessData(db.prisma);
		const counts = await Promise.all([db.prisma.achievements.count(), db.prisma.avatar_items.count(), db.prisma.quest_templates.count(), db.prisma.chores.count()]);
		expect(counts.every(n => n > 0)).toBe(true);
		const achievement = (await store.rows("achievements"))[0];
		await store.update("achievements", Number(achievement.id), { points_reward: 999 });
		const c = await makeChore();
		await assign(c.id);
		const rules = await store.rows("chore_assignment_rules");
		await seedBusinessData(db.prisma);
		expect(await db.prisma.chores.count()).toBe(counts[3] + 1);
		expect(await db.prisma.achievements.count()).toBe(counts[0]);
		expect((await store.one("achievements", Number(achievement.id), "Achievement")).points_reward).toBe(999);
		expect(await store.rows("chore_assignment_rules")).toEqual(rules);
		expect((await store.one("users", admin, "User")).password_hash).toBe(before.password_hash);
		expect(await db.prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
	});
	it("exercises remaining CRUD, feedback, approval and rotation contracts", async () => {
		const created = await req("post", "/api/chores/categories").send({ name: "Bedroom", icon: "bed", colour: "#123456" }).expect(201);
		await req("put", `/api/chores/categories/${created.body.id}`).send({ name: "Room", icon: "home", colour: "#abcdef" }).expect(200);
		await req("get", "/api/chores/categories", kid).expect(200);
		await req("delete", `/api/chores/categories/${created.body.id}`).expect(204);
		await req("delete", `/api/chores/categories/${created.body.id}`).expect(404);
		const c = await makeChore();
		await assign(c.id);
		await req("get", `/api/chores/${c.id}`, kid).expect(200);
		await req("get", "/api/chores?view=active").expect(200);
		await req("get", "/api/chores", kid).expect(200);
		await req("put", `/api/chores/${c.id}`).send({ title: "Dishes updated", assigned_user_ids: [kid] }).expect(200);
		const rule = (await req("get", `/api/chores/${c.id}/rules`).expect(200)).body[0];
		await req("put", `/api/chores/rules/${rule.id}`).send({ requires_photo: false }).expect(200);
		const rotation = await req("post", "/api/rotations").send({ chore_id: c.id, kid_ids: [kid, other], cadence: "daily" }).expect(201);
		await req("get", "/api/rotations").expect(200);
		await req("get", `/api/chores/${c.id}/rotation`).expect(200);
		await req("post", `/api/rotations/${rotation.body.id}/advance`).expect(200);
		await req("put", `/api/rotations/${rotation.body.id}`).send({ kid_ids: [other], cadence: "weekly" }).expect(200);
		await req("get", `/api/chores/${c.id}/debug`).expect(200);
		await req("delete", `/api/rotations/${rotation.body.id}`).expect(200);
		const slot = (await store.rows("chore_assignments"))[0];
		await req("post", `/api/chores/assignments/${slot.id}/feedback`).send({ feedback: "Well done" }).expect(200);
		await req("post", `/api/chores/${c.id}/skip`).expect(200);
		await req("delete", `/api/chores/rules/${rule.id}`).expect(204);
		await req("post", "/api/chores/cleanup-all-stale").expect(200);
		await req("get", "/api/chores/templates").expect(200);
		const reward = await req("post", "/api/rewards").send({ title: "Prize", point_cost: 5 }).expect(201);
		await req("get", "/api/rewards", kid).expect(200);
		await req("get", `/api/rewards/${reward.body.id}`, kid).expect(200);
		await req("put", `/api/rewards/${reward.body.id}`).send({ point_cost: 6, stock: 1 }).expect(200);
		const redemption = await store.insert("reward_redemptions", { reward_id: reward.body.id, user_id: kid, points_spent: 6, status: "pending", approved_by: null, approved_at: null, fulfilled_by: null, fulfilled_at: null });
		await req("post", `/api/rewards/redemptions/${redemption.id}/approve`).expect(200);
		await req("get", "/api/rewards/redemptions?status=bad").expect(400);
		const event = await req("post", "/api/events").send({ title: "Festival", multiplier: 1.5, start_date: new Date().toISOString(), end_date: new Date(Date.now() + 100000).toISOString() }).expect(201);
		await req("put", `/api/events/${event.body.id}`).send({ title: "Festival update" }).expect(200);
		await req("get", "/api/events", kid).expect(200);
		await req("post", `/api/events/${event.body.id}/end`).expect(200);
		await req("delete", `/api/events/${event.body.id}`).expect(200);
		const vacation = await req("post", "/api/vacation").send({ start_date: day(), end_date: day() }).expect(201);
		await req("get", "/api/vacation").expect(200);
		await req("delete", `/api/vacation/${vacation.body.id}`).expect(204);
		const wish = await req("post", "/api/wishlist", kid).send({ title: "Wish" }).expect(201);
		await req("put", `/api/wishlist/${wish.body.id}`, kid).send({ notes: "Updated" }).expect(200);
		await req("delete", `/api/wishlist/${wish.body.id}`).expect(200);
		await req("get", `/api/points/${kid}`, kid).expect(200);
		await req("post", `/api/points/adjust/${kid}`, admin).send({ amount: 4, description: "Test adjustment" }).expect(200);
		const n = (await req("get", "/api/notifications", kid).expect(200)).body[0];
		await req("post", `/api/notifications/${n.id}/read`, kid).expect(200);
		await req("get", "/api/spin/availability", kid).expect(200);
		await request(app).get("/api/avatar/parts").expect(200);
	});
	it("enforces daily spin and pet budgets across duplicate and concurrent requests", async () => {
		const results = await Promise.all([req("post", "/api/spin/spin", kid), req("post", "/api/spin/spin", kid)]);
		expect(results.map(r => r.status).sort()).toEqual([200, 400]);
		expect(await db.prisma.spin_results.count()).toBe(1);
		await store.update("users", kid, { avatar_config: { pet: "cat", pet_xp: 49 } });
		const first = await req("post", "/api/pets/interact", kid).send({ action: "feed" }).expect(200);
		expect(first.body.levelup).toMatchObject({ old_level: 1, new_level: 2 });
		await req("put", "/api/avatar", kid).send({ config: { pet: "cat", pet_xp: 999999, pet_xp_map: { cat: 999999 }, pet_interactions: { date: day(), count: 0 } } }).expect(200);
		const calls = await Promise.all(Array.from({ length: 3 }, () => req("post", "/api/pets/interact", kid).send({ action: "play" })));
		expect(calls.map(r => r.status).sort()).toEqual([200, 200, 400]);
		expect((await store.one("users", kid, "User")).avatar_config).toMatchObject({ pet_xp: 57, pet_xp_map: { cat: 57 }, pet_interactions: { count: 3 } });
		await req("post", "/api/pets/interact", kid).send({ action: "hack" }).expect(422);
	});
	it("purchases shop items once and unlocks XP milestones idempotently on read", async () => {
		await store.update("users", kid, { points_balance: 50, total_points_earned: 100 });
		const shop = await store.insert("avatar_items", { category: "hat", item_id: "cap", display_name: "Cap", rarity: "common", unlock_method: "shop", unlock_value: 20, is_default: false });
		await store.insert("avatar_items", { category: "hat", item_id: "crown", display_name: "Crown", rarity: "epic", unlock_method: "xp", unlock_value: 100, is_default: false });
		const results = await Promise.all([req("post", `/api/avatar/items/${shop.id}/purchase`, kid), req("post", `/api/avatar/items/${shop.id}/purchase`, kid)]);
		expect(results.map(r => r.status).sort()).toEqual([200, 400]);
		expect((await store.one("users", kid, "User")).points_balance).toBe(30);
		const first = await req("get", "/api/avatar/items", kid).expect(200);
		expect(first.body.every((i: {
			unlocked: boolean;
		}) => i.unlocked)).toBe(true);
		await req("get", "/api/avatar/items", kid).expect(200);
		expect(await db.prisma.user_avatar_items.count()).toBe(2);
	});
	it("protects pet XP and interaction budgets through the existing profile-update API too", async () => {
		await store.update("users", kid, { avatar_config: { pet: "cat", pet_xp: 50, pet_xp_map: { cat: 50 }, pet_interactions: { date: day(), count: 3, actions: ["pet", "pet", "pet"] } } });
		await req("put", "/api/auth/me", kid).send({ avatar_config: { pet: "cat", hat: "cap", pet_xp: 999999, pet_xp_map: { cat: 999999 }, pet_interactions: { date: day(), count: 0 } } }).expect(200);
		expect((await store.one("users", kid, "User")).avatar_config).toMatchObject({ hat: "cap", pet_xp: 50, pet_xp_map: { cat: 50 }, pet_interactions: { count: 3 } });
		await req("post", "/api/pets/interact", kid).send({ action: "play" }).expect(400);
	});
	it("corrects stale streak reads, preserves vacation gaps and consumes a freeze only once per month", async () => {
		const today = day(), old = { ...(await store.one("users", kid, "User")), current_streak: 4, longest_streak: 4, last_streak_date: addDays(today, -3) };
		expect(effectiveStreak(old, [], today)).toBe(0);
		const vacation = { start_date: addDays(today, -2), end_date: addDays(today, -1), is_active: true };
		expect(effectiveStreak(old, [vacation], today)).toBe(4);
		await store.update("users", kid, pickForStreak(old));
		await advanceStreak(store, old, today);
		expect(old).toMatchObject({ current_streak: 5, streak_freezes_used: 1 });
		const next = { ...old, last_streak_date: addDays(today, -3) };
		await advanceStreak(store, next, today);
		expect(next.current_streak).toBe(1);
	});
	it("allows parent settings while blocking auth-state takeover and private-key disclosure", async () => {
		await db.prisma.$executeRaw `INSERT INTO app_settings (key,value,updated_at) VALUES ('vapid_private_key','test-only-private-value','2030-01-01 00:00:00')`;
		const settings = await req("get", "/api/admin/settings").expect(200);
		expect(JSON.stringify(settings.body)).not.toContain("private-value");
		await req("get", "/api/admin/settings/features", kid).expect(200, { leaderboard_enabled: "true", spin_wheel_enabled: "true", chore_trading_enabled: "true" });
		await req("put", "/api/admin/settings").send({ settings: { spin_wheel_enabled: "false" } }).expect(200);
		await req("put", "/api/admin/settings").send({ settings: { initial_password_setup_required: "true" } }).expect(400);
		await req("get", "/api/admin/users", parent).expect(403);
	});
	it("persists household interactions with date limits and notifications", async () => {
		await req("post", "/api/announcements").send({ title: "News", message: "Family meeting", is_pinned: true }).expect(200);
		const list = await req("get", "/api/announcements", kid).expect(200);
		expect(list.body[0]).toMatchObject({ creator_name: "Parent", is_pinned: true });
		expect(await db.prisma.notifications.count()).toBe(2);
		await req("post", "/api/shoutouts", kid).send({ to_user_id: kid, message: "No" }).expect(400);
		for (let i = 0; i < 5; i++)
			await req("post", "/api/shoutouts", kid).send({ to_user_id: other, message: "Thanks!" }).expect(201);
		await req("post", "/api/shoutouts", kid).send({ to_user_id: other, message: "Again" }).expect(429);
		expect((await req("get", "/api/shoutouts", kid).expect(200)).body).toHaveLength(5);
	});
	it("returns report contracts, percentage completion and positive weekly XP without leaking credentials", async () => {
		const c = await makeChore();
		await assign(c.id);
		await req("post", `/api/chores/${c.id}/complete`, kid).expect(200);
		await req("post", `/api/points/${kid}/bonus`).send({ amount: 9, description: "Fixture" }).expect(200);
		// Python groups transactions by UTC stored date but computes the week
		// from local date.today(). Pin this fixture away from midnight/week edges.
		for (const tx of await store.rows("point_transactions"))
			await store.update("point_transactions", Number(tx.id), { created_at: `${day()}T12:00:00Z` });
		const stats = await req("get", "/api/stats/me", kid).expect(200);
		expect(stats.body).toMatchObject({ completion_rate: 100, points_balance: 9, rank: { title: "Apprentice" } });
		const leaderboard = await req("get", "/api/stats/leaderboard", kid).expect(200);
		expect(leaderboard.body[0]).toMatchObject({ id: kid, weekly_xp: 9, quests_completed: 1 });
		const progress = await req("get", "/api/progress", kid).expect(200);
		expect(progress.body.days).toHaveLength(30);
		expect(progress.body.summary).toMatchObject({ total_xp: 9, total_completed: 1, total_assigned: 1, completion_rate: 1 });
		for (const url of ["/api/stats/kids", "/api/stats/party", "/api/stats/family", `/api/stats/family/${kid}`, `/api/stats/${kid}`, `/api/stats/history/${kid}`, "/api/stats/achievements/all"]) {
			const response = await req("get", url).expect(200);
			expect(JSON.stringify(response.body)).not.toMatch(/password_hash|pin_hash/);
		}
	});
	it("preserves subscription ownership and reports deferred delivery honestly", async () => {
		const body = { endpoint: "https://push.example.test/synthetic", keys: { p256dh: "fixture", auth: "fixture" } };
		await req("post", "/api/push/subscribe", kid).send(body).expect(200);
		await req("post", "/api/push/subscribe", kid).send(body).expect(200);
		expect(await db.prisma.push_subscriptions.count()).toBe(1);
		await req("get", "/api/push/status", other).expect(200, { subscribed: false });
		await req("post", "/api/push/unsubscribe", other).send(body).expect(404);
		await req("post", "/api/push/subscribe").send(body).expect(200);
		await req("post", "/api/push/test").expect(501);
		await req("post", "/api/emotes", kid).send({ emote: "wave" }).expect(501);
		await req("get", "/api/push/vapid-public-key", kid).expect(503);
	});
	it("writes Python-readable datetime and ISO date-only text and passes foreign-key checks", async () => {
		const c = await makeChore();
		await assign(c.id);
		await req("post", `/api/chores/${c.id}/complete`, kid).expect(200);
		const rows = await db.prisma.$queryRaw<Array<{
			date: string;
			completed_at: string;
			kind: string;
		}>> `SELECT CAST(date AS TEXT) AS date, CAST(completed_at AS TEXT) AS completed_at, typeof(completed_at) AS kind FROM chore_assignments`;
		expect(rows[0].date).toMatch(/^\d{4}-\d\d-\d\d$/);
		expect(rows[0].completed_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/);
		expect(rows[0].kind).toBe("text");
		expect(await db.prisma.$queryRaw `PRAGMA foreign_key_check`).toEqual([]);
	});
});
function pickForStreak(row: Row): Row { return { current_streak: row.current_streak, longest_streak: row.longest_streak, last_streak_date: row.last_streak_date }; }
