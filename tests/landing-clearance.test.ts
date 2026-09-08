import { describe, expect, it } from 'vitest';
import { DOUBLE_JUMP_GRAVITY_MPS2 } from '../app/game/boosters';
import { EMPTY_INPUT, FIXED_DT, LANE_X } from '../app/game/constants';
import type { GameEvent, InputFrame, VehicleKind } from '../app/game/contracts';
import {
  AutorooSimulation,
  createTrafficVehicle,
} from '../app/game/simulation';

const tap: InputFrame = { ...EMPTY_INPUT, jumpPressed: true, jumpTapped: true };
type Flight = 'rocket' | 'double-jump';

function clearTick(run: AutorooSimulation, input: InputFrame = EMPTY_INPUT) {
  run.__debugReplaceTraffic([]);
  run.__debugReplacePickups([]);
  run.tick(input);
}

function descendingRun(flight: Flight) {
  const run = new AutorooSimulation(17);
  run.start();
  run.__debugReplaceTraffic([]);
  if (flight === 'rocket') {
    run.__debugReplacePickups([
      { id: 'rocket', kind: 'rocket', lane: 1, absoluteZM: 0, yM: 1.2 },
    ]);
    run.tick(EMPTY_INPUT);
    while (run.renderBoosters.rocket!.elapsedS < 3.65) clearTick(run);
  } else {
    run.__debugSetBoosters({ doubleJumpCount: 1 });
    clearTick(run, tap);
    for (let i = 0; i < 20; i++) clearTick(run);
    clearTick(run, tap);
    while (run.renderPlayer.verticalSpeedMps > 0 || run.renderPlayer.yM > 7)
      clearTick(run);
  }
  run.drainEvents();
  return run;
}

function touchdownZM(run: AutorooSimulation) {
  if (run.renderBoosters.rocket) return run.renderBoosters.rocket.landingZM;
  const p = run.renderPlayer;
  const seconds =
    (p.verticalSpeedMps +
      Math.sqrt(
        p.verticalSpeedMps ** 2 + 2 * DOUBLE_JUMP_GRAVITY_MPS2 * p.yM,
      )) /
    DOUBLE_JUMP_GRAVITY_MPS2;
  return (
    p.absoluteZM + Math.ceil(seconds / FIXED_DT) * FIXED_DT * p.takeoffSpeedMps
  );
}

function land(run: AutorooSimulation, input: InputFrame = EMPTY_INPUT) {
  const events: GameEvent[] = [];
  for (
    let i = 0;
    i < 100 && run.renderPlayer.airborne && run.phaseName === 'running';
    i++
  ) {
    run.tick(input);
    events.push(...run.drainEvents());
  }
  return events;
}

describe.each(['rocket', 'double-jump'] as const)(
  '%s landing pocket',
  (flight) => {
    it.each(['sedan', 'suv', 'bus'] as const)(
      'clears a %s before roof contact without spending a shield or scoring the car',
      (kind: VehicleKind) => {
        const run = descendingRun(flight);
        const z = touchdownZM(run);
        run.__debugSetBoosters({ shieldCount: 2 });
        run.__debugReplaceTraffic([
          createTrafficVehicle(
            'hit',
            'landing-test',
            kind,
            'ordinary',
            1,
            z,
            0,
          ),
        ]);
        const events: GameEvent[] = [];
        let poofHeight = 0;
        while (run.renderPlayer.airborne && run.phaseName === 'running') {
          run.tick(EMPTY_INPUT);
          const batch = run.drainEvents();
          if (batch.some((event) => event.type === 'landing-poof'))
            poofHeight = run.renderPlayer.yM;
          events.push(...batch);
        }
        expect(run.phaseName).toBe('running');
        expect(run.renderPlayer.yM).toBe(0);
        expect(poofHeight).toBeGreaterThan(2.85);
        expect(run.renderBoosters).toMatchObject({
          shieldCount: 2,
          protectionS: 0,
        });
        const poofs = events.filter((event) => event.type === 'landing-poof');
        expect(poofs).toHaveLength(1);
        expect(poofs[0]).toMatchObject({
          first: true,
          vehicles: [{ id: 'hit' }],
        });
        expect(
          events.filter(
            (event) => event.type === 'crash' || event.type === 'shield-pop',
          ),
        ).toEqual([]);
        expect(
          events.filter(
            (event) =>
              event.type === 'bonus' && event.label !== 'SPECIAL DELIVERY!',
          ),
        ).toEqual([]);
      },
    );

    it('clears the small forward pocket without a car-count cap and preserves adjacent/distant traffic', () => {
      const run = descendingRun(flight);
      const z = touchdownZM(run);
      const cars = [
        createTrafficVehicle('under-1', 'test', 'sedan', 'ordinary', 1, z, 0),
        createTrafficVehicle('under-2', 'test', 'suv', 'ordinary', 1, z + 3, 0),
        createTrafficVehicle('forward', 'test', 'bus', 'gate', 1, z + 12, 0),
        createTrafficVehicle(
          'body-edge',
          'test',
          'bus',
          'ordinary',
          1,
          z + 20,
          0,
        ),
        createTrafficVehicle('adjacent', 'test', 'bus', 'ordinary', 2, z, 0),
        createTrafficVehicle(
          'distant',
          'test',
          'sedan',
          'ordinary',
          1,
          z + 25,
          0,
        ),
        createTrafficVehicle(
          'behind',
          'test',
          'sedan',
          'ordinary',
          1,
          run.renderPlayer.absoluteZM - 12,
          0,
        ),
      ];
      run.__debugReplaceTraffic(cars);
      const events = land(run);
      expect(run.phaseName).toBe('running');
      const ids = events.flatMap((event) =>
        event.type === 'landing-poof' ? event.vehicles.map((v) => v.id) : [],
      );
      expect(ids.sort()).toEqual([
        'body-edge',
        'forward',
        'under-1',
        'under-2',
      ]);
      expect(
        run.renderTraffic
          .filter((v) => ['adjacent', 'distant'].includes(v.id))
          .map((v) => v.id)
          .sort(),
      ).toEqual(['adjacent', 'distant']);
      expect(run.renderBoosters.protectionS).toBe(0);
      run.__debugReplaceTraffic([
        createTrafficVehicle(
          'next-hit',
          'test',
          'sedan',
          'ordinary',
          1,
          run.renderPlayer.absoluteZM + 3,
          0,
        ),
      ]);
      run.tick(EMPTY_INPUT);
      expect(run.phaseName).toBe('game-over');
    });

    it('catches moving traffic and late physical lane changes throughout descent, then stops', () => {
      const run = descendingRun(flight);
      const z = touchdownZM(run);
      run.__debugReplaceTraffic([
        createTrafficVehicle('first', 'test', 'sedan', 'ordinary', 1, z, 0),
      ]);
      const events: GameEvent[] = [];
      while (!events.some((event) => event.type === 'landing-poof')) {
        run.tick(EMPTY_INPUT);
        events.push(...run.drainEvents());
        expect(run.phaseName).toBe('running');
      }
      // Commit a lane change after the first puff; target lane differs from physical X.
      run.__debugReplaceTraffic([
        createTrafficVehicle(
          'late-bus',
          'test',
          'bus',
          'ordinary',
          2,
          z - 2,
          8,
        ),
      ]);
      run.tick({ ...EMPTY_INPUT, laneDelta: 1 });
      events.push(...run.drainEvents());
      expect(run.renderPlayer.lane).toBe(2);
      expect(run.renderPlayer.xM).toBeLessThan(LANE_X[2]);
      events.push(...land(run));
      expect(run.phaseName).toBe('running');
      const poofs = events.filter((event) => event.type === 'landing-poof');
      expect(
        poofs.flatMap((event) => event.vehicles.map((v) => v.id)),
      ).toContain('late-bus');
      expect(poofs.filter((event) => event.first)).toHaveLength(1);
      expect(poofs.at(-1)?.first).toBe(false);
    });

    it('freezes mid-poof on pause and replays deterministically', () => {
      const run = descendingRun(flight);
      const replay = descendingRun(flight);
      const z = touchdownZM(run);
      for (const game of [run, replay])
        game.__debugReplaceTraffic([
          createTrafficVehicle('hit', 'test', 'bus', 'ordinary', 1, z, 0),
        ]);
      const beforePause: GameEvent[] = [];
      while (!beforePause.some((event) => event.type === 'landing-poof')) {
        run.tick(EMPTY_INPUT);
        replay.tick(EMPTY_INPUT);
        const events = run.drainEvents();
        expect(replay.drainEvents()).toEqual(events);
        beforePause.push(...events);
      }
      run.setPaused(true);
      const frozen = run.snapshot();
      for (let i = 0; i < 120; i++) run.tick(tap);
      expect(run.snapshot()).toEqual(frozen);
      expect(run.drainEvents()).toEqual([]);
      run.setPaused(false);
      expect(land(run)).toEqual(land(replay));
      expect(run.snapshot()).toEqual(replay.snapshot());
      run.restart();
      expect(run.renderBoosters.protectionS).toBe(0);
      expect(run.drainEvents()).toEqual([]);
    });
  },
);

it('ordinary jumps still collide on descent even with unspent double jumps', () => {
  const run = new AutorooSimulation(17);
  run.start();
  run.__debugSetBoosters({ doubleJumpCount: 2 });
  clearTick(run, tap);
  while (run.renderPlayer.verticalSpeedMps > 0 || run.renderPlayer.yM > 3.5)
    clearTick(run);
  run.drainEvents();
  run.__debugReplaceTraffic([
    createTrafficVehicle(
      'ordinary-hit',
      'test',
      'bus',
      'ordinary',
      1,
      run.renderPlayer.absoluteZM + 3,
      0,
    ),
  ]);
  const events = land(run);
  expect(run.phaseName).toBe('game-over');
  expect(events.some((event) => event.type === 'landing-poof')).toBe(false);
  expect(run.renderBoosters.doubleJumpCount).toBe(2);
});
