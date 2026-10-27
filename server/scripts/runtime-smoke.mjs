import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";

// Invoked only by the disposable process/container harnesses below. Never takes
// a CLI URL/password, reads .env, or prints response bodies/credentials.
export async function exercise(base, password) {
  async function http(path, method = "GET", token, body) {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(15000), headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert(response.ok, `${method} ${path} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  assert.equal((await http("/api/health")).status, "ok");
  assert.equal((await http("/api/auth/setup-status")).setup_required, true);
  const login = (username) => http("/api/auth/login", "POST", undefined, { username, password });
  const admin = await login("Admin"), adminToken = admin.access_token;
  assert.equal((await http("/api/auth/setup-status")).setup_required, false);
  const accounts = [];
  for (const [username, role] of [["SmokeParent", "parent"], ["SmokeKid", "kid"]])
    accounts.push(await http("/api/admin/users", "POST", adminToken, { username, display_name: username, role, password }));
  const parent = (await login("SmokeParent")).access_token, kid = (await login("SmokeKid")).access_token;
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws/${accounts[1].id}`, ["chorequest", `bearer.${kid}`], { origin: base });
  socket.on("error", () => undefined);
  const events = [];
  socket.on("message", data => events.push(JSON.parse(String(data))));
  try {
    await Promise.race([once(socket, "open"), new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("WS handshake timeout")), 10000); t.unref(); })]);
    const categories = await http("/api/chores/categories", "GET", parent);
    const chore = await http("/api/chores", "POST", parent, { title: "Deployment smoke", points: 20, difficulty: "easy", category_id: categories[0].id, recurrence: "daily", assigned_user_ids: [accounts[1].id] });
    await http(`/api/chores/${chore.id}/complete`, "POST", kid);
    const detail = await http(`/api/chores/${chore.id}`, "GET", parent);
    await http(`/api/chores/assignments/${detail.assignments.find(a => a.user_id === accounts[1].id).id}/verify`, "POST", parent);
    const me = await http("/api/auth/me", "GET", kid);
    assert(me.points_balance >= 20, "Verified points missing");
    const reward = await http("/api/rewards", "POST", parent, { title: "Smoke reward", point_cost: 5 });
    await http(`/api/rewards/${reward.id}/redeem`, "POST", kid);
    assert((await http("/api/rewards/redemptions", "GET", parent)).length > 0);
    // Upload exercises native sharp decoding and durable upload serving.
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNwq9jiVrGFAUIBACbOBcneHHP5AAAAAElFTkSuQmCC", "base64")], { type: "image/png" }), "fixture.png");
    const uploaded = await fetch(base + "/api/uploads", { method: "POST", headers: { Authorization: `Bearer ${kid}` }, body: form, signal: AbortSignal.timeout(15000) });
    assert(uploaded.ok, `Upload returned ${uploaded.status}`);
    const upload = await uploaded.json();
    const notifications = await http("/api/notifications", "GET", kid);
    assert(notifications.length > 0, "Notifications missing");
    const vapid = await http("/api/push/vapid-public-key", "GET", kid);
    for (let i = 0; i < 100 && !events.some(e => e.type === "chore_verified"); i++) await new Promise(r => setTimeout(r, 20));
    assert(events.some(e => e.type === "chore_verified"), "Committed private WS event missing");
    assert((await (await fetch(base + "/")).text()).includes("<html"), "Built frontend missing");
    return { kid, parent, admin: adminToken, kidId: accounts[1].id, points: (await http("/api/auth/me", "GET", kid)).points_balance, vapid: vapid.public_key, upload };
  } finally {
    socket.close();
    socket.terminate();
  }
}

export async function verifyRestart(base, state) {
  const response = await fetch(base + "/api/auth/me", { headers: { Authorization: `Bearer ${state.kid}` }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const me = await response.json();
  assert.equal(me.id, state.kidId);
  assert.equal(me.points_balance, state.points);
  const key = await fetch(base + "/api/push/vapid-public-key", { headers: { Authorization: `Bearer ${state.kid}` } });
  assert.equal((await key.json()).public_key, state.vapid);
  assert(state.upload.path, "Upload path missing");
  const image = await fetch(base + state.upload.path, { headers: { Authorization: `Bearer ${state.kid}` } });
  assert.equal(image.status, 200);
}
