import { mkdtemp, open, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UploadStorage } from "../../src/business/uploads.js";
import { PNG } from "../helpers/images.js";

vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, open: vi.fn(actual.open), unlink: vi.fn(actual.unlink) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
let directory: string, storage: UploadStorage;
beforeEach(async () => {
	directory = await mkdtemp(resolve(tmpdir(), "chorequest-image-test-"));
	storage = new UploadStorage(directory, 1);
});
afterEach(async () => {
	vi.mocked(open).mockReset().mockImplementation(actualFs.open);
	vi.mocked(unlink).mockReset().mockImplementation(actualFs.unlink);
	vi.restoreAllMocks();
	await rm(directory, { recursive: true, force: true });
});
const file = (data: Buffer, type = "image/png", name = "image.png") => new File([new Uint8Array(data)], name, { type });

it.each(["jpeg", "png", "gif", "webp"] as const)("fully decodes valid %s content and uses a safe normalized filename", async format => {
	const bytes = await sharp(PNG).toFormat(format).toBuffer();
	const filename = await storage.save(file(bytes, `image/${format}`, "../../spoofed.html"));
	expect(filename).toMatch(new RegExp(`^[a-f0-9]{32}\\.${format === "jpeg" ? "jpg" : format}$`));
	expect(await readFile(storage.path(filename))).toEqual(bytes);
	expect(await readdir(directory)).toEqual([filename]);
});
it.each(["gif", "webp"] as const)("supports valid animated %s rather than checking just its first frame", async format => {
	const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
	const bytes = await sharp([PNG, red], { join: { animated: true } }).toFormat(format).toBuffer();
	expect((await sharp(bytes, { animated: true }).metadata()).pages).toBe(2);
	await expect(storage.save(file(bytes, `image/${format}`, `animation.${format}`))).resolves.toMatch(/^[a-f0-9]{32}\./);
});
it.each([Buffer.from("<html>not an image</html>"), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), Buffer.alloc(0)])("rejects spoofed image MIME content without creating files", async bytes => {
	await expect(storage.save(file(bytes))).rejects.toMatchObject({ status: 400 });
	expect(await readdir(directory)).toEqual([]);
});
it("rejects a valid image whose claimed MIME disagrees with decoded format", async () => {
	await expect(storage.save(file(PNG, "image/jpeg", "photo.jpg"))).rejects.toMatchObject({ status: 400 });
	expect(await readdir(directory)).toEqual([]);
});
it.each(["jpeg", "png", "gif", "webp"] as const)("rejects malformed/truncated %s bytes", async format => {
	const bytes = await sharp(PNG).toFormat(format).toBuffer();
	await expect(storage.save(file(bytes.subarray(0, Math.floor(bytes.length / 2)), `image/${format}`))).rejects.toMatchObject({ status: 400 });
	expect(await readdir(directory)).toEqual([]);
});
it("forces pixel decoding instead of accepting a PNG with a readable header but truncated pixels", async () => {
	const truncated = PNG.subarray(0, PNG.indexOf(Buffer.from("IDAT")) + 8);
	await expect(sharp(truncated).metadata()).resolves.toMatchObject({ format: "png" });
	await expect(storage.save(file(truncated))).rejects.toMatchObject({ status: 400 });
	expect(await readdir(directory)).toEqual([]);
});
it("keeps the byte limit before decoding or writing", async () => {
	await expect(storage.save(file(Buffer.alloc(1024 * 1024 + 1)))).rejects.toMatchObject({ status: 400, detail: "File too large. Max 1MB" });
	expect(vi.mocked(open)).not.toHaveBeenCalled();
});
function partialWriteFailure() {
	vi.mocked(open).mockImplementationOnce(async (...args) => {
		const handle = await actualFs.open(...args), write = handle.writeFile.bind(handle);
		vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
			await write(Buffer.from("partial"));
			throw Object.assign(new Error("test-only private disk detail"), { code: "ENOSPC" });
		});
		return handle;
	});
}
it("removes a file created by this request when writing fails partway through", async () => {
	partialWriteFailure();
	await expect(storage.save(file(PNG))).rejects.toMatchObject({ code: "ENOSPC" });
	expect(await readdir(directory)).toEqual([]);
});
it("does not discard another request's existing file when exclusive creation fails", async () => {
	vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("collision"), { code: "EEXIST" }));
	await expect(storage.save(file(PNG))).rejects.toMatchObject({ code: "EEXIST" });
	expect(vi.mocked(unlink)).not.toHaveBeenCalled();
});
it("reports cleanup failures generically without masking the write failure or leaking paths", async () => {
	partialWriteFailure();
	vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error(`private path ${directory}`), { code: "EACCES" }));
	const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	await expect(storage.save(file(PNG))).rejects.toMatchObject({ code: "ENOSPC" });
	expect(await readdir(directory)).toHaveLength(1);
	expect(warning).toHaveBeenCalledOnce();
	expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private path|private disk/);
	expect(JSON.stringify(warning.mock.calls)).not.toContain(directory);
});
it("treats an already absent rollback file as successfully cleaned", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	await storage.discard("a".repeat(32) + ".png");
	expect(warning).not.toHaveBeenCalled();
});
