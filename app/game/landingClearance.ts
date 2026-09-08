import {
  FIXED_DT,
  LANE_X,
  LATERAL_COLLISION_MARGIN_M,
  LONGITUDINAL_MARGIN_M,
  PLAYER_LENGTH_M,
  PLAYER_WIDTH_M,
} from './constants';
import { DOUBLE_JUMP_GRAVITY_MPS2, ROCKET_DURATION_S } from './boosters';
import type { BoosterState, PlayerState, TrafficVehicle } from './contracts';

// One short terminal-descent sweep. There is no protection after touchdown.
export const LANDING_CLEARANCE_LEAD_S = 0.16;
export const LANDING_CLEARANCE_MIN_AHEAD_M = 8;
export const LANDING_CLEARANCE_MAX_AHEAD_M = 16;
const READJUST_S = 0.65;

export function landingSecondsRemaining(
  player: Readonly<PlayerState>,
  boosts: Readonly<BoosterState>,
): number {
  if (player.yM >= player.previousYM) return Number.POSITIVE_INFINITY;
  if (boosts.rocket)
    return Math.max(0, ROCKET_DURATION_S - boosts.rocket.elapsedS);
  // The double-jump marker is cleared by physics on the touchdown tick.
  if (!player.airborne) return 0;
  const v = player.verticalSpeedMps;
  return (
    (v + Math.sqrt(v * v + 2 * DOUBLE_JUMP_GRAVITY_MPS2 * player.yM)) /
    DOUBLE_JUMP_GRAVITY_MPS2
  );
}

/** Body overlap with a narrow landing corridor, including the current sweep. */
export function isInsideLandingPocket(
  player: Readonly<PlayerState>,
  vehicle: Readonly<TrafficVehicle>,
  landingZM: number,
  remainingS: number,
  drivingSpeedMps: number,
): boolean {
  const side = PLAYER_WIDTH_M / 2 + LATERAL_COLLISION_MARGIN_M + 0.15;
  const vehicleX = LANE_X[vehicle.lane];
  if (
    vehicleX + vehicle.widthM / 2 <
      Math.min(player.previousXM, player.xM) - side ||
    vehicleX - vehicle.widthM / 2 >
      Math.max(player.previousXM, player.xM) + side
  )
    return false;

  const aheadM = Math.max(
    LANDING_CLEARANCE_MIN_AHEAD_M,
    Math.min(
      LANDING_CLEARANCE_MAX_AHEAD_M,
      Math.max(0, drivingSpeedMps - vehicle.speedMps) * READJUST_S,
    ),
  );
  const rearZM =
    player.previousZM - PLAYER_LENGTH_M / 2 - LONGITUDINAL_MARGIN_M;
  const frontZM = landingZM + PLAYER_LENGTH_M / 2 + aheadM;
  const futureZM =
    vehicle.retireAtZM === null
      ? vehicle.absoluteZM + vehicle.speedMps * Math.max(FIXED_DT, remainingS)
      : Math.min(
          vehicle.retireAtZM,
          vehicle.absoluteZM +
            vehicle.speedMps * Math.max(FIXED_DT, remainingS),
        );
  return (
    Math.max(vehicle.absoluteZM, futureZM) + vehicle.lengthM / 2 >= rearZM &&
    Math.min(vehicle.previousZM, futureZM) - vehicle.lengthM / 2 <= frontZM
  );
}
