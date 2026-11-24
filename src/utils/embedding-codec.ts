// Binary embedding storage — encode/decode for the `embedding` bytea columns
// on transcripts and chunks. Raw float32 binary instead of JSON-text: ~4KB per
// 1024-dim vector instead of ~55KB as full-precision JSON text, and no
// per-row JSON.parse on read. See [[project_johnny]] recall-latency
// investigation: JSON-text storage was the dominant cost in every embedding
// fetch, independent of network/socket/pool overhead (all measured fast).
export function encodeEmbedding(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function decodeEmbedding(buf: Buffer): number[] {
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(floats);
}
