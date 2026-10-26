import type { ErrorRequestHandler } from "express";
import { AccountSchemaError } from "../db/accountSchema.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
	if (res.headersSent) {
		return;
	}
	if (err instanceof AccountSchemaError) {
		res.status(503).json({ detail: err.message });
		return;
	}
	// body-parser's SyntaxError contains the original body, including possible
	// passwords. Neither parser nor database exceptions are safe to log verbatim.
	if (err?.type === "entity.parse.failed") {
		res.status(422).json({ detail: [{ type: "json_invalid", loc: ["body"], msg: "JSON decode error" }] });
		return;
	}
	if (err?.type === "entity.too.large") {
		res.status(413).json({ detail: "Request body too large" });
		return;
	}
	console.error("Unhandled request error");

	res.status(500).json({
		error: "Internal Server Error",
		message: "An unexpected error occurred.",
	});
};
