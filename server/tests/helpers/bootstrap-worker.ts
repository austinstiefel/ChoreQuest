import { PrismaClient } from "@prisma/client";
import { bootstrapInitialAdmin, loadBootstrapConfig } from "../../src/auth/bootstrap.js";

// Independent process, explicit disposable URL; never load application dotenv.
const prisma = new PrismaClient({ datasources: { db: { url: process.argv[2] } } });
try {
	console.log(await bootstrapInitialAdmin(prisma, loadBootstrapConfig({})));
} finally {
	await prisma.$disconnect();
}
