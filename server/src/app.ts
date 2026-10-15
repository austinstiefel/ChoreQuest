import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFound.js";
import { healthRouter } from "./routes/health.js";

export const app = express();

app.disable("x-powered-by");

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/api/health", healthRouter);

app.use(notFoundHandler);
app.use(errorHandler);
