import type { Request, Response, NextFunction } from "express";

export function notFoundHandler(req: Request, res: Response, _next: NextFunction): void {
	res.status(404).json({
		error: "Not Found",
		message: `No route found for ${req.method} ${req.path}`,
	});
}
