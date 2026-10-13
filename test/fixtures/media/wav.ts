// Small WAV files made in code for the player's tests: 16-bit mono PCM at
// 8 kHz (16 KB a second), a quiet tone that every browser decodes.

export function wav(seconds: number, opts: { rate?: number; tone?: number } = {}): Uint8Array {
  const rate = opts.rate ?? 8000;
  const tone = opts.tone ?? 440;
  const samples = Math.round(seconds * rate);
  const bytes = new Uint8Array(44 + samples * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true); // PCM header size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // bytes a second
  v.setUint16(32, 2, true); // bytes a frame
  v.setUint16(34, 16, true); // bits a sample
  text(36, "data");
  v.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * tone * i) / rate) * 2000), true);
  }
  return bytes;
}
