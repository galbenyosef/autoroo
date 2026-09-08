import {
  LANE_X,
  FIXED_DT,
  BASE_SPEED_MPS,
  ACCELERATION_MPS2,
  activeLanes,
} from './constants';
import type {
  BoosterKind,
  BoosterPickup,
  BoosterState,
  PlayerState,
} from './contracts';
import { laneMaskAt, isSteadyRoadRange } from './generator';
import { hashParts, hashUnit } from './random';

export const BOOSTER_SPACING_M = 240;
export const BOOSTER_POOL_SIZE = 6;
const BOOSTER_CYCLE: readonly BoosterKind[] = [
  'boing',
  'shield',
  'boing',
  'rocket',
  'boing',
  'shield',
];
export const DOUBLE_JUMP_IMPULSE_MPS = 28;
export const DOUBLE_JUMP_GRAVITY_MPS2 = 34;
export const ROCKET_DURATION_S = 4;
export const ROCKET_DISTANCE_M = 480;
export const ROCKET_HEIGHT_M = 26;
export const ROCKET_BONUS = 750;
export const SHIELD_GRACE_S = 1.5;

export const BOOSTER_INFO = {
  boing: {
    name: 'Boing!',
    rarity: 'Common',
    color: '#b4ff49',
    instruction: 'One extra jump. Tap JUMP (or Space) again in midair.',
  },
  rocket: {
    name: 'Yeet Rocket',
    rarity: 'Rare',
    color: '#ff9861',
    instruction:
      'Auto-launch! Steer midair, poof nearby landing traffic, and land for +750.',
  },
  shield: {
    name: 'Bubble Buddy',
    rarity: 'Uncommon',
    color: '#63e7ff',
    instruction:
      'Each bubble soaks up one crash. Collect more to stack shields.',
  },
} as const;

export function makeBoosterState(): BoosterState {
  return {
    doubleJumpCount: 0,
    shieldCount: 0,
    protectionS: 0,
    doubleJumpOriginYM: null,
    doubleJumpElapsedS: 0,
    doubleJumpUsedThisFlight: false,
    rocket: null,
    effect: null,
    effectRemainingS: 0,
  };
}

/** Three springs, two bubbles and one rocket per seeded 1,440 m block. */
export function boosterAtStation(
  seed: number,
  station: number,
): BoosterPickup | null {
  const block = Math.floor(station / BOOSTER_CYCLE.length);
  const slot =
    (station + (hashParts(seed, block, 811) % BOOSTER_CYCLE.length)) %
    BOOSTER_CYCLE.length;
  const kind = BOOSTER_CYCLE[slot];
  const absoluteZM =
    (station + 1) * BOOSTER_SPACING_M + hashUnit(seed, station, 821) * 14;
  // Never lure the player into a closing lane or a taper.
  if (!isSteadyRoadRange(seed, absoluteZM - 20, absoluteZM + 20)) return null;
  const lanes = activeLanes(laneMaskAt(seed, absoluteZM));
  // Alternating road edges make the player leave the centre and plan a sweep.
  const lane = station % 2 === 0 ? lanes[lanes.length - 1] : lanes[0];
  return {
    id: `booster-${station}`,
    kind,
    lane,
    absoluteZM,
    yM: kind === 'boing' ? 1.2 : kind === 'shield' ? 3.4 : 4.8,
  };
}

/** Pass through or above a pickup during the SAME lateral/forward interval. */
export function collectsBooster(
  player: Readonly<PlayerState>,
  pickup: BoosterPickup,
): boolean {
  let entry = 0;
  let exit = 1;
  const axes = [
    [player.previousZM, player.absoluteZM, pickup.absoluteZM, 2.1],
    [player.previousXM, player.xM, LANE_X[pickup.lane], 0.85],
  ];
  for (const [start, end, centre, radius] of axes) {
    const delta = end - start;
    if (Math.abs(delta) < 1e-9) {
      if (Math.abs(start - centre) > radius) return false;
      continue;
    }
    const a = (centre - radius - start) / delta;
    const b = (centre + radius - start) / delta;
    entry = Math.max(entry, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (entry > exit) return false;
  }
  // A jump over a pickup counts, but driving underneath a floating pickup
  // does not. Intersect this lower height bound with the X/Z overlap so a
  // late jump or a lane change after passing cannot collect it retroactively.
  const startYM = player.previousYM + 0.7;
  const deltaYM = player.yM - player.previousYM;
  const minimumYM = pickup.yM - 0.85;
  if (Math.abs(deltaYM) < 1e-9) return startYM >= minimumYM;
  const crossing = (minimumYM - startYM) / deltaYM;
  if (deltaYM > 0) entry = Math.max(entry, crossing);
  else exit = Math.min(exit, crossing);
  return entry <= exit;
}

/** Handles forward/vertical flight; lateral movement uses normal lane changes. */
export function advanceBoosterFlight(
  player: PlayerState,
  boosts: BoosterState,
  speedLimitMps = BASE_SPEED_MPS,
  accelerationMps2 = ACCELERATION_MPS2,
): boolean {
  const rocket = boosts.rocket;
  if (!rocket && boosts.doubleJumpOriginYM === null) return false;
  player.previousYM = player.yM;
  player.previousZM = player.absoluteZM;
  // Custom arcs use linear per-tick swept heights, not the normal jump parabola.
  player.jumpElapsedS = 0;
  if (rocket) {
    rocket.elapsedS = Math.min(ROCKET_DURATION_S, rocket.elapsedS + FIXED_DT);
    const t = rocket.elapsedS / ROCKET_DURATION_S;
    player.absoluteZM =
      rocket.startZM + (rocket.landingZM - rocket.startZM) * t;
    player.yM = rocket.startYM * (1 - t) + 4 * ROCKET_HEIGHT_M * t * (1 - t);
    player.verticalSpeedMps =
      (-rocket.startYM + 4 * ROCKET_HEIGHT_M * (1 - 2 * t)) / ROCKET_DURATION_S;
    player.speedMps = (rocket.landingZM - rocket.startZM) / ROCKET_DURATION_S;
    player.takeoffSpeedMps = player.speedMps;
    player.airborne = true;
    if (t >= 1 - 1e-9) {
      player.airborne = false;
      player.yM = 0;
      player.verticalSpeedMps = 0;
      player.speedMps = speedLimitMps;
      player.takeoffSpeedMps = speedLimitMps;
    }
  } else {
    player.speedMps = Math.min(
      speedLimitMps,
      player.speedMps + accelerationMps2 * FIXED_DT,
    );
    boosts.doubleJumpElapsedS += FIXED_DT;
    const t = boosts.doubleJumpElapsedS;
    player.absoluteZM += player.takeoffSpeedMps * FIXED_DT;
    player.yM = Math.max(
      0,
      boosts.doubleJumpOriginYM! +
        DOUBLE_JUMP_IMPULSE_MPS * t -
        0.5 * DOUBLE_JUMP_GRAVITY_MPS2 * t * t,
    );
    player.verticalSpeedMps =
      DOUBLE_JUMP_IMPULSE_MPS - DOUBLE_JUMP_GRAVITY_MPS2 * t;
    if (player.yM === 0) {
      player.airborne = false;
      player.verticalSpeedMps = 0;
      boosts.doubleJumpOriginYM = null;
    }
  }
  player.maxForwardM = Math.max(player.maxForwardM, player.absoluteZM);
  return true;
}
