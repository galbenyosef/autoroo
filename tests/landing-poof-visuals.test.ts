import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import {
  LandingPoofVisuals,
  landingPoofCarPose,
} from '../app/game/landingPoofVisuals';
import { BabylonGameSession } from '../app/game/BabylonGameSession';
import { createTrafficVehicle } from '../app/game/simulation';
import { FIXED_DT } from '../app/game/constants';

describe('landing poof presentation', () => {
  it('squashes before shrinking, supports reduced motion, and keeps all poses finite', () => {
    expect(landingPoofCarPose(0, false)).toEqual({
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      roll: 0,
    });
    const squash = landingPoofCarPose(0.05, false);
    expect(squash.scaleY).toBeLessThan(0.6);
    expect(squash.scaleX).toBeGreaterThan(1);
    expect(landingPoofCarPose(0.2, false).scaleX).toBeLessThan(0.01);
    for (let frame = 0; frame <= 30; frame++) {
      const pose = landingPoofCarPose(frame / 60, false);
      expect(Object.values(pose).every(Number.isFinite)).toBe(true);
      expect(Math.min(pose.scaleX, pose.scaleY, pose.scaleZ)).toBeGreaterThan(
        0,
      );
      const quiet = landingPoofCarPose(frame / 60, true);
      expect(quiet.roll).toBe(0);
      expect(quiet.scaleX).toBe(quiet.scaleY);
    }
  });

  it('keeps dust bounded and reusable, freezes with the run clock, and resets interrupted effects', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    new FreeCamera('test', new Vector3(0, 5, -12), scene);
    const visuals = new LandingPoofVisuals(scene);
    const meshCount = scene.meshes.length;
    const materialCount = scene.materials.length;
    const vehicle = createTrafficVehicle(
      'gone',
      'test',
      'bus',
      'ordinary',
      1,
      25,
      8,
    );
    const event = {
      type: 'landing-poof' as const,
      tick: 59,
      first: true,
      vehicles: [vehicle],
    };
    visuals.start(event, false);
    visuals.update(10, 1.12);
    const dust = scene.getMeshByName('landing-poof-0-0')!;
    expect(dust.isEnabled()).toBe(true);
    const pose = {
      position: dust.position.clone(),
      scaling: dust.scaling.clone(),
      visibility: dust.visibility,
    };
    for (let frame = 0; frame < 120; frame++) visuals.update(10, 1.12);
    expect(dust.position).toEqual(pose.position);
    expect(dust.scaling).toEqual(pose.scaling);
    expect(dust.visibility).toBe(pose.visibility);
    expect(() => scene.render()).not.toThrow();
    visuals.update(20, 1.5);
    let ghosts = 0;
    visuals.forEachCar(() => ghosts++);
    expect(ghosts).toBe(0);
    expect(scene.meshes.every((mesh) => !mesh.isEnabled())).toBe(true);
    for (let i = 0; i < 100; i++) {
      visuals.start(
        { ...event, tick: 119, vehicles: [{ ...vehicle, id: `gone-${i}` }] },
        i % 2 === 0,
      );
      visuals.update(20, 2.12);
    }
    expect(scene.meshes.length).toBe(meshCount);
    expect(scene.materials.length).toBe(materialCount);
    visuals.reset();
    expect(scene.meshes.every((mesh) => !mesh.isEnabled())).toBe(true);
    visuals.forEachCar(() => {
      throw new Error('reset kept a car');
    });
    scene.dispose();
    engine.dispose();
  });

  it('restores a pooled car and shadow after its disappearing pose', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const entry = {
      holder: new TransformNode('car', scene),
      shadow: new Mesh('shadow', scene),
      groundY: 0,
      enabled: true,
    };
    const vehicle = createTrafficVehicle(
      'car',
      'test',
      'sedan',
      'ordinary',
      1,
      25,
      0,
    );
    entry.holder.scaling.setAll(0.1);
    entry.holder.rotation.z = 0.12;
    entry.shadow.setEnabled(false);
    const place = (
      BabylonGameSession.prototype as unknown as {
        placeTrafficVisual(
          entry: unknown,
          vehicle: unknown,
          z: number,
          alpha: number,
        ): void;
      }
    ).placeTrafficVisual.bind(BabylonGameSession.prototype);
    place(entry, vehicle, 0, 1);
    expect(entry.holder.scaling).toEqual(new Vector3(1, 1, 1));
    expect(entry.holder.rotation).toEqual(Vector3.Zero());
    expect(entry.shadow.isEnabled()).toBe(true);
    // A recycled entry outside the visibility band is fully hidden again.
    place(entry, vehicle, 1000, FIXED_DT);
    expect(entry.holder.isEnabled()).toBe(false);
    expect(entry.shadow.isEnabled()).toBe(false);
    scene.dispose();
    engine.dispose();
  });
});
