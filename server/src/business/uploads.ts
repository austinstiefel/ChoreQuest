import { randomUUID } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { Request } from "express";
import { BusinessError } from "./store.js";
import type { BusinessRouter } from "./router.js";
import sharp from "sharp";
const extensions: Record<string, string[]> = { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"], "image/gif": [".gif"], "image/webp": [".webp"] };
const imageFormats: Record<string, string> = { "image/jpeg": "jpeg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
const MAX_IMAGE_PIXELS = 25_000_000;

/** A magic check only gates access to the decoder (notably excluding SVG/XML).
 * The decoder then reads actual pixel data for every GIF/WebP frame, rejecting
 * corrupt/truncated images, format mismatches and excessive decoded dimensions. */
async function verifyImage(contents: Buffer, mime: string): Promise<void> {
	const signature = contents.subarray(0, 12);
	const raster = signature.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
		signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
		["GIF87a", "GIF89a"].includes(signature.toString("ascii", 0, 6)) ||
		(signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP");
	try {
		if (!raster) throw new Error();
		const image = sharp(contents, { animated: true, failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS });
		const metadata = await image.metadata();
		if (metadata.format !== imageFormats[mime]) throw new Error();
		// metadata() alone accepts some truncated files. stats() forces a full
		// pixel decode without materializing a potentially huge raw output buffer.
		await image.stats();
	} catch {
		throw new BusinessError(400, "Invalid image content. Upload a valid JPEG, PNG, GIF, or WebP image (maximum 25 million decoded pixels).");
	}
}
export class Download {
	constructor(readonly path: string) { }
}
export class UploadStorage {
	constructor(readonly directory = resolve(process.env.UPLOAD_DIR ?? "/app/data/uploads"), readonly maxSizeMb = Number(process.env.MAX_UPLOAD_SIZE_MB ?? 5)) {
		if (!Number.isSafeInteger(maxSizeMb) || maxSizeMb <= 0)
			throw new Error("Invalid MAX_UPLOAD_SIZE_MB configuration");
	}
	async parse(request: Request): Promise<File | null> {
		const type = request.get("Content-Type");
		if (!type?.startsWith("multipart/form-data"))
			return null;
		const limit = this.maxSizeMb * 1024 * 1024, chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > limit + 65536)
				throw new BusinessError(400, `File too large. Max ${this.maxSizeMb}MB`);
			chunks.push(buffer);
		}
		try {
			const data = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { "Content-Type": type } }).formData(), file = data.get("file");
			return file && typeof file !== "string" ? file : null;
		}
		catch {
			throw new BusinessError(422, [{ type: "value_error", loc: ["body", "file"], msg: "Invalid multipart form data" }]);
		}
	}
	async save(file: File): Promise<string> {
		const allowed = extensions[file.type];
		if (!allowed)
			throw new BusinessError(400, "Invalid file type. Allowed: JPEG, PNG, GIF, WebP");
		if (file.size > this.maxSizeMb * 1024 * 1024)
			throw new BusinessError(400, `File too large. Max ${this.maxSizeMb}MB`);
		const contents = Buffer.from(await file.arrayBuffer());
		await verifyImage(contents, file.type);
		const raw = /\.[a-z]+$/i.exec(file.name)?.[0].toLowerCase(), ext = raw && allowed.includes(raw) ? raw : allowed[0], name = randomUUID().replaceAll("-", "") + ext;
		await mkdir(this.directory, { recursive: true });
		// Open exclusively before entering the cleanup scope: a collision must
		// never cause us to remove a file that this request did not create.
		const handle = await open(resolve(this.directory, name), "wx");
		try {
			await handle.writeFile(contents);
			await handle.close();
		} catch (error) {
			await handle.close().catch(() => undefined);
			await this.discard(name);
			throw error;
		}
		return name;
	}
	/** Rollback is best-effort across the filesystem boundary. A failed unlink
	 * must be observable without exposing a private path or masking the DB error. */
	async discard(name: string): Promise<void> {
		try { await unlink(this.path(name)); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Upload cleanup failed; an unreferenced file may require operator cleanup.");
		}
	}
	path(name: string): string {
		if (!/^[a-f0-9]{32}\.(?:jpg|jpeg|png|gif|webp)$/i.test(name))
			throw new BusinessError(404, "File not found");
		return resolve(this.directory, name);
	}
	async existing(name: string): Promise<string> {
		const path = this.path(name);
		try {
			if (!(await stat(path)).isFile())
				throw new Error();
		}
		catch {
			throw new BusinessError(404, "File not found");
		}
		return path;
	}
	async remove(name: string) { await unlink(await this.existing(name)); }
}
export function registerUploads(api: BusinessRouter, storage: UploadStorage) {
	api.add({ method: "post", path: "/api/uploads", role: "authenticated", writes: false, multipart: true, async run({ file }) {
			if (!file)
				throw new BusinessError(422, [{ type: "missing", loc: ["body", "file"], msg: "Field required" }]);
			const filename = await storage.save(file);
			return { path: `/api/uploads/${filename}`, filename };
		} });
	api.add({ method: "get", path: "/api/uploads/:filename", role: "public", async run({ request }) { return new Download(await storage.existing(String(request.params.filename))); } });
	api.add({ method: "delete", path: "/api/uploads/:filename", role: "parent", writes: false, async run({ request }) { await storage.remove(String(request.params.filename)); return { detail: "Deleted" }; } });
}
