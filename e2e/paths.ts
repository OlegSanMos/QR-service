import { fileURLToPath } from 'node:url';

export const CACHE_DIR = fileURLToPath(new URL('./.cache/', import.meta.url));
/** Y4M clip of a QR stream that Chromium plays as its fake camera. */
export const FAKE_CAMERA_VIDEO = `${CACHE_DIR}qr-stream.y4m`;
/** The file encoded into that clip. */
export const FAKE_CAMERA_SOURCE = `${CACHE_DIR}source.txt`;
