import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import type { GameEvent, TrafficVehicle } from './contracts';
import { FIXED_DT, LANE_X } from './constants';

export const LANDING_POOF_DURATION_S = 0.46;
export const LANDING_POOF_CAR_DURATION_S = 0.2;
const POOL_SIZE = 24;
const PUFF_COUNT = 5;

interface PoofEntry {
  vehicle: Readonly<TrafficVehicle> | null;
  startedAtS: number;
  reducedMotion: boolean;
  elapsedS: number;
  readonly puffs: Mesh[];
}

/** Local dust and temporary car poses, entirely driven by the paused run clock. */
export class LandingPoofVisuals {
  private readonly entries: PoofEntry[];

  constructor(scene: Scene) {
    const dust = new StandardMaterial('landing-poof-cream', scene);
    dust.diffuseColor = Color3.FromHexString('#fff0c9');
    dust.emissiveColor = Color3.FromHexString('#b6a18c').scale(0.45);
    dust.specularColor = Color3.Black();
    dust.freeze();
    this.entries = Array.from({ length: POOL_SIZE }, (_, slot) => ({
      vehicle: null,
      startedAtS: 0,
      reducedMotion: false,
      elapsedS: 0,
      puffs: Array.from({ length: PUFF_COUNT }, (_, i) => {
        const puff = CreateSphere(
          `landing-poof-${slot}-${i}`,
          { diameter: 1, segments: 4 },
          scene,
        );
        puff.material = dust;
        puff.isPickable = false;
        puff.setEnabled(false);
        return puff;
      }),
    }));
  }

  start(
    event: Extract<GameEvent, { type: 'landing-poof' }>,
    reducedMotion: boolean,
  ): void {
    for (const vehicle of event.vehicles) {
      // This cap is presentation-only; it never limits collision removal.
      const entry =
        this.entries.find((candidate) => candidate.vehicle === null) ??
        this.entries.reduce((oldest, candidate) =>
          candidate.startedAtS < oldest.startedAtS ? candidate : oldest,
        );
      entry.vehicle = vehicle;
      entry.startedAtS = (event.tick + 1) * FIXED_DT;
      entry.reducedMotion = reducedMotion;
      entry.elapsedS = 0;
    }
  }

  reset(): void {
    for (const entry of this.entries) {
      entry.vehicle = null;
      for (const puff of entry.puffs) puff.setEnabled(false);
    }
  }

  update(playerZ: number, seconds: number): void {
    for (const entry of this.entries) {
      const vehicle = entry.vehicle;
      if (!vehicle) continue;
      const elapsed = Math.max(0, seconds - entry.startedAtS);
      entry.elapsedS = elapsed;
      if (elapsed >= LANDING_POOF_DURATION_S) {
        entry.vehicle = null;
        for (const puff of entry.puffs) puff.setEnabled(false);
        continue;
      }
      const t = Math.max(
        0,
        (elapsed - 0.08) / (LANDING_POOF_DURATION_S - 0.08),
      );
      for (let i = 0; i < entry.puffs.length; i += 1) {
        const puff = entry.puffs[i];
        puff.setEnabled(elapsed >= 0.08);
        const angle = (i * Math.PI * 2) / PUFF_COUNT + 0.3;
        const spread = entry.reducedMotion ? 0.6 : 0.35 + t * 1.5;
        puff.position.set(
          LANE_X[vehicle.lane] + Math.cos(angle) * spread,
          0.35 + (i % 2) * 0.3 + (entry.reducedMotion ? 0 : t * 0.6),
          vehicle.absoluteZM +
            vehicle.speedMps * Math.min(elapsed, LANDING_POOF_CAR_DURATION_S) -
            playerZ +
            Math.sin(angle) * spread,
        );
        const size =
          (entry.reducedMotion ? 0.65 : 0.35 + Math.sin(t * Math.PI) * 0.85) *
          (1 - t * 0.3);
        puff.scaling.set(size, size * 0.8, size);
        puff.visibility = (1 - t) * 0.8;
      }
    }
  }

  forEachCar(
    draw: (
      vehicle: Readonly<TrafficVehicle>,
      elapsedS: number,
      reducedMotion: boolean,
    ) => void,
  ): void {
    for (const entry of this.entries) {
      if (entry.vehicle && entry.elapsedS < LANDING_POOF_CAR_DURATION_S)
        draw(entry.vehicle, entry.elapsedS, entry.reducedMotion);
    }
  }
}

export function landingPoofCarPose(elapsedS: number, reducedMotion: boolean) {
  const t = Math.max(0, Math.min(1, elapsedS / LANDING_POOF_CAR_DURATION_S));
  const shrink = Math.max(0.001, 1 - t * t);
  const squash = reducedMotion
    ? 0
    : Math.sin(Math.min(1, t * 2) * Math.PI) * 0.5;
  return {
    scaleX: shrink * (1 + squash * 0.35),
    scaleY: shrink * (1 - squash),
    scaleZ: shrink * (1 + squash * 0.2),
    roll: reducedMotion ? 0 : Math.sin(t * Math.PI * 2) * 0.12,
  };
}
