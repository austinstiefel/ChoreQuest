import { PrismaClient } from "@prisma/client";
import { DailyScheduler, localDay, dailySlot } from "../../src/runtime/scheduler.js";
const [url, instant, hour = "0"] = process.argv.slice(2);
if (!url?.includes("chorequest-auth-") || !instant)
	throw new Error("Disposable scheduler fixture required");
const prisma = new PrismaClient({ datasources: { db: { url } } });
try {
	const now = new Date(instant), scheduler = new DailyScheduler(prisma, Number(hour));
	console.log(JSON.stringify({ ran: await scheduler.run(now, true), today: localDay(now), slot: dailySlot(now, Number(hour)), offset: now.getTimezoneOffset() }));
}
finally {
	await prisma.$disconnect();
}
