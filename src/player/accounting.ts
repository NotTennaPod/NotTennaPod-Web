// Android's listening arithmetic (Media3PlaybackService 3.12.1, PROTOCOL §8): played duration as
// forward media displacement from the baseline the player took when it loaded the episode,
// frozen below it; completion within the smart threshold; rewind after pause; the speed list.

/** The browser's smart mark-as-played threshold (PROTOCOL §15: 30 seconds). */
export const thresholdMs = 30_000;
/** Android's defaults: rewind 10 s, fast-forward 30 s, a save every 5 s. */
export const rewindMs = 10_000;
export const fastForwardMs = 30_000;
export const saveIntervalMs = 5_000;
/** Checkpoint facts while playing: at most one a minute (PROTOCOL §8). */
export const exportIntervalMs = 60_000;

/** Baseline is where the accounting restarts: the player loaded the episode. */
export interface Baseline {
  position: number;
  contribution: number; // the session's contribution when the baseline began
}

/**
 * contribution is Android's played duration for a save at position:
 * playedDurationWhenStarted + (position − startPosition) when the position is
 * past the baseline, else the previous save's value. Speed never scales it.
 */
export function contribution(base: Baseline, previous: number, position: number): number {
  return position > base.position ? base.contribution + (position - base.position) : previous;
}

/** almostEnded is Android's completion test with the browser's threshold. */
export function almostEnded(position: number, duration: number, threshold = thresholdMs): boolean {
  return duration > 0 && position >= duration - threshold;
}

/** RewindAfterPauseUtils: resuming rewinds by how long ago the episode was last played. */
export function rewindAfterPause(position: number, lastPlayed: number, now: number): number {
  if (position <= 0 || lastPlayed <= 0) return position;
  const elapsed = now - lastPlayed;
  let rewind = 0;
  if (elapsed > 24 * 3600_000) rewind = 20_000;
  else if (elapsed > 3600_000) rewind = 10_000;
  else if (elapsed > 60_000) rewind = 3_000;
  else if (elapsed > 0) rewind = 800;
  return Math.max(position - rewind, 0);
}

/** Android's playback speed presets until changed, and its speed bar's range. */
export const defaultSpeeds = [1.0, 1.25, 1.5];
export const minSpeed = 0.5;
export const maxSpeed = 4.0;

/** speedStep is PlaybackSpeedSeekBar's 0.05 step, clamped to its range. */
export function speedStep(speed: number, steps: number): number {
  const p = Math.round(speed * 20 - 10) + steps;
  return Math.min(maxSpeed, Math.max(minSpeed, (Math.min(70, Math.max(0, p)) + 10) / 20));
}

/** formatSpeed is Android's "%1$.2f". */
export function formatSpeed(speed: number): string {
  return speed.toFixed(2);
}
