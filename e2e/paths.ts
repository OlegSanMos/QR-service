import { fileURLToPath } from 'node:url';

export const CACHE_DIR = fileURLToPath(new URL('./.cache/', import.meta.url));
/** Y4M clip of a QR stream that Chromium plays as its fake camera. */
export const FAKE_CAMERA_VIDEO = `${CACHE_DIR}qr-stream.y4m`;
/** The file encoded into that clip. */
export const FAKE_CAMERA_SOURCE = `${CACHE_DIR}source.txt`;
/** Second file of the archive in that clip. */
export const FAKE_CAMERA_SOURCE_CSV = `${CACHE_DIR}table.csv`;
/** Incompressible third file of that archive (keeps the transfer a few seconds long). */
export const FAKE_CAMERA_SOURCE_BIN = `${CACHE_DIR}random.bin`;
/** Clip with two codes on screen at once, and the file it carries. */
export const MULTI_CAMERA_VIDEO = `${CACHE_DIR}qr-multi.y4m`;
export const MULTI_CAMERA_SOURCE = `${CACHE_DIR}multi.bin`;
/** Small, slow clip (8 codes/s) for the resume tests: long enough to reload mid-transfer. */
export const RESUME_CAMERA_VIDEO = `${CACHE_DIR}resume-stream.y4m`;
/** The file encoded into that clip. */
export const RESUME_CAMERA_SOURCE = `${CACHE_DIR}resume.txt`;
