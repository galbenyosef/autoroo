export type LaneIndex = 0 | 1 | 2 | 3;
export type LaneMask = number;
export type RunPhase = 'ready' | 'running' | 'paused' | 'game-over';
export type VehicleKind = 'sedan' | 'suv' | 'bus';
export type VehicleRole = 'ordinary' | 'gate';
export type BoosterKind = 'boing' | 'rocket' | 'shield';

export interface BoosterPickup {
  readonly id: string;
  readonly kind: BoosterKind;
  readonly lane: LaneIndex;
  readonly absoluteZM: number;
  readonly yM: number;
}

export interface RocketFlight {
  elapsedS: number;
  readonly startZM: number;
  readonly startYM: number;
  readonly landingZM: number;
}

export interface BoosterState {
  /** Charges belong to this run and reset when a new run starts. */
  doubleJumpCount: number;
  shieldCount: number;
  /** Remaining simulation time, so protection freezes when paused. */
  protectionS: number;
  doubleJumpOriginYM: number | null;
  doubleJumpElapsedS: number;
  doubleJumpUsedThisFlight: boolean;
  rocket: RocketFlight | null;
  effect: 'boing' | 'rocket' | 'shield-pop' | 'landing' | null;
  effectRemainingS: number;
}

export interface InputFrame {
  readonly laneDelta: -1 | 0 | 1;
  readonly jumpPressed: boolean;
  /** Fresh physical press only; held auto-hop must not spend a booster. */
  readonly jumpTapped?: boolean;
}

export interface PlayerState {
  lane: LaneIndex;
  /** Physical lateral centre; `lane` is the committed destination. */
  xM: number;
  previousXM: number;
  laneChangeStartXM: number;
  laneChangeElapsedS: number;
  laneChangeDirection: -1 | 0 | 1;
  queuedLane: LaneIndex | null;
  absoluteZM: number;
  previousZM: number;
  yM: number;
  previousYM: number;
  /** Cruising speed; an airborne arc keeps its separate takeoff speed. */
  speedMps: number;
  verticalSpeedMps: number;
  airborne: boolean;
  takeoffSpeedMps: number;
  jumpElapsedS: number;
  maxForwardM: number;
}

export interface TrafficVehicle {
  id: string;
  encounterId: string;
  kind: VehicleKind;
  role: VehicleRole;
  lane: LaneIndex;
  absoluteZM: number;
  previousZM: number;
  speedMps: number;
  lengthM: number;
  widthM: number;
  heightM: number;
  airborneOverlap: boolean;
  closePassOverlap: boolean;
  bonusAwarded: boolean;
  locked: boolean;
  certificateId: string | null;
  /** Immutable forward boundary where an ordinary encounter leaves the road. */
  retireAtZM: number | null;
}

export interface RoadTransition {
  readonly kind: 'add' | 'remove';
  readonly lane: LaneIndex;
  readonly warningEndM: number;
  readonly taperEndM: number;
}

export interface RoadModule {
  readonly index: number;
  readonly startM: number;
  readonly endM: number;
  readonly fromLaneMask: LaneMask;
  readonly toLaneMask: LaneMask;
  readonly transition: RoadTransition | null;
  readonly trafficAllowed: boolean;
}

export interface WitnessTracePoint {
  readonly tick: number;
  readonly lane: LaneIndex;
  readonly xMM: number;
  readonly zMM: number;
  readonly yMM: number;
  readonly speedMMps: number;
  readonly input: InputFrame;
}

export interface ChallengeManeuver {
  /** Longitudinal row centre relative to the first row in the challenge. */
  readonly offsetM: number;
  /** Lanes occupied by blockers when the challenge is locked. */
  readonly blockedLaneMask: LaneMask;
  /** Full rows demand a hop; dodge rows intersect the low landing beat. */
  readonly action: 'jump' | 'dodge';
  /** Certified lane for this beat (also the command target after the prior row). */
  readonly targetLane: LaneIndex;
}

export interface ChallengeApproachRoute {
  /** Existing ordinary encounter that must be cleared before the mixed chain. */
  readonly encounterId: string;
  /** The already-certified escape lane for that encounter. */
  readonly targetLane: LaneIndex;
}

export interface ChallengeCertificate {
  readonly version: 1;
  readonly id: string;
  readonly kind: 'ground' | 'jump';
  readonly gateSeed: number;
  readonly locked: boolean;
  readonly revealTick: number;
  readonly lockedStateHash: string;
  readonly dependencyHash: string;
  readonly targetLane: LaneIndex;
  readonly selectedVehicle: VehicleKind;
  readonly approachRoutes: readonly ChallengeApproachRoute[];
  readonly maneuverPlan: readonly ChallengeManeuver[];
  readonly blockerIds: readonly string[];
  readonly blockerTrajectories: readonly {
    id: string;
    encounterId: string;
    lane: LaneIndex;
    startTick: number;
    startZM: number;
    speedMps: number;
    retireAtZM: number | null;
  }[];
  readonly safeTakeoffTickMin: number;
  readonly safeTakeoffTickMax: number;
  readonly minimumSpeedMps: number;
  readonly targetSpeedMps: number;
  readonly verticalClearanceM: number;
  readonly longitudinalMarginM: number;
  readonly timingMarginTicks: number;
  readonly inputWindowS: number;
  readonly witnessTraceHash: string;
  readonly witness: readonly WitnessTracePoint[];
}

export interface RunSnapshot {
  readonly version: 1;
  readonly seed: number;
  readonly tick: number;
  readonly phase: RunPhase;
  readonly elapsedS: number;
  readonly player: Readonly<PlayerState>;
  readonly traffic: readonly Readonly<TrafficVehicle>[];
  readonly pickups: readonly Readonly<BoosterPickup>[];
  readonly boosters: Readonly<BoosterState>;
  readonly score: number;
  readonly bonusScore: number;
  readonly difficulty: number;
  readonly laneMask: LaneMask;
  readonly laneCount: number;
  readonly activeCertificate: ChallengeCertificate | null;
  readonly lastBonusLabel: string | null;
}

export interface AssetCredit {
  readonly file: string;
  readonly sha256: string;
  readonly author: string;
  readonly title: string;
  readonly source: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly modificationNotes: string;
}

export type GameEvent =
  | { readonly type: 'pickup'; readonly kind: BoosterKind }
  | { readonly type: 'double-jump' }
  | { readonly type: 'rocket-launch' }
  | { readonly type: 'rocket-land' }
  | {
      readonly type: 'landing-poof';
      readonly tick: number;
      /** Play one sound for the whole landing, even if steering catches another car. */
      readonly first: boolean;
      readonly vehicles: readonly Readonly<TrafficVehicle>[];
    }
  | { readonly type: 'shield-pop' }
  | { readonly type: 'jump' }
  | { readonly type: 'lane-change' }
  | { readonly type: 'warning' }
  | { readonly type: 'crash' }
  | { readonly type: 'bonus'; readonly label: string; readonly points: number };
