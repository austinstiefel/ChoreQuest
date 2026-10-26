import { PrismaClient } from "@prisma/client";
import { requireSqliteFile } from "./sqliteFile.js";

// Never let startup create an empty database because of a mistyped URL.
requireSqliteFile(process.env.DATABASE_URL);

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
