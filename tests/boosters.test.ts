import { describe, expect, it } from 'vitest';
import {
  BOOSTER_POOL_SIZE,
  BOOSTER_SPACING_M,
  DOUBLE_JUMP_IMPULSE_MPS,
  ROCKET_BONUS,
  ROCKET_DISTANCE_M,
  ROCKET_DURATION_S,
  ROCKET_HEIGHT_M,
  SHIELD_GRACE_S,
  boosterAtStation,
  collectsBooster,
} from '../app/game/boosters';
import {
  EMPTY_INPUT,
  START_SPEED_MPS,
  FIXED_DT,
  LANE_X,
  LANE_CHANGE_TICKS,
  BASE_SPEED_MPS,
  TRAFFIC_RENDER_AHEAD_M,
  activeLanes,
  hasLane,
} from '../app/game/constants';
import type {
  BoosterKind,
  BoosterPickup,
  InputFrame,
} from '../app/game/contracts';
import { laneMaskAt, isSteadyRoadRange } from '../app/game/generator';
import { InputBuffer } from '../app/game/input';
import { laneChangeAnimationPose } from '../app/game/laneChangeAnimation';
import {
  AutorooSimulation,
  createTrafficVehicle,
  runRenderSchedule,
} from '../app/game/simulation';
import { certificateBotInput } from './bot-driver';

const drive: InputFrame = { ...EMPTY_INPUT };
const tap: InputFrame = { ...drive, jumpPressed: true, jumpTapped: true };

function emptyRun(seed = 17) {
  const run = new AutorooSimulation(seed);
  run.start();
  run.__debugReplaceTraffic([]);
  run.__debugReplacePickups([]);
  return run;
}

function pickup(kind: BoosterKind, z = 0, y = 1.2): BoosterPickup {
  return { id: `test-${kind}`, kind, lane: 1, absoluteZM: z, yM: y };
}

function clearTick(run: AutorooSimulation, input: InputFrame = drive) {
  run.__debugReplaceTraffic([]);
  run.tick(input);
}

describe('collectible generation and collection', () => {
  it('repeats deterministically with ordered rarity and manoeuvre targets on stable road', () => {
    const counts = { boing: 0, shield: 0, rocket: 0 };
    for (let seed = 0; seed < 20; seed += 1) {
      let previousPickupM = 0;
      for (let station = 0; station < 240; station += 1) {
        const item = boosterAtStation(seed, station);
        expect(item).toEqual(boosterAtStation(seed, station));
        if (!item) continue;
        expect(item.absoluteZM - previousPickupM).toBeGreaterThan(225);
        previousPickupM = item.absoluteZM;
        counts[item.kind] += 1;
        expect(
          isSteadyRoadRange(seed, item.absoluteZM - 20, item.absoluteZM + 20),
        ).toBe(true);
        const lanes = activeLanes(laneMaskAt(seed, item.absoluteZM));
        expect(item.lane).toBe(station % 2 === 0 ? lanes.at(-1) : lanes[0]);
      }
    }
    expect(counts.boing).toBeGreaterThan(counts.shield);
    expect(counts.boing).toBeLessThan(counts.shield * 2);
    expect(counts.shield).toBeGreaterThan(counts.rocket * 1.5);
    expect(counts.rocket).toBeGreaterThan(100);
    const sampledKm = (20 * 240 * BOOSTER_SPACING_M) / 1000;
    expect(counts.boing / sampledKm).toBeLessThan(2.1);
    expect(counts.shield / sampledKm).toBeLessThan(1.5);
    expect(counts.rocket / sampledKm).toBeLessThan(0.8);
  });

  it('requires lane alignment, and a jump for bubbles and rockets', () => {
    const player = emptyRun().snapshot().player;
    expect(collectsBooster(player, pickup('boing'))).toBe(true);
    expect(
      collectsBooster(
        { ...player, xM: LANE_X[2], previousXM: LANE_X[2] },
        pickup('boing'),
      ),
    ).toBe(false);
    expect(collectsBooster(player, pickup('shield', 0, 3.4))).toBe(false);
    expect(collectsBooster(player, pickup('rocket', 0, 4.8))).toBe(false);
    expect(
      collectsBooster(
        { ...player, yM: 4.3, previousYM: 4.3 },
        pickup('rocket', 0, 4.8),
      ),
    ).toBe(true);
  });

  it('sweeps through pickups at high speed without combining disjoint axis overlaps', () => {
    const player = emptyRun().snapshot().player;
    expect(
      collectsBooster(
        { ...player, previousZM: -5, absoluteZM: 5 },
        pickup('boing'),
      ),
    ).toBe(true);
    const laneTwoPickup = { ...pickup('boing'), lane: 2 as const };
    expect(
      collectsBooster(
        { ...player, previousZM: 0, absoluteZM: 20, xM: LANE_X[2] },
        laneTwoPickup,
      ),
    ).toBe(false);
    expect(
      collectsBooster(
        { ...player, previousZM: -4, absoluteZM: 0, xM: LANE_X[2] },
        laneTwoPickup,
      ),
    ).toBe(true);
  });

  it.each(['boing', 'shield', 'rocket'] as const)(
    'collects a %s passed above while requiring the same lane and forward overlap',
    (kind) => {
      const player = {
        ...emptyRun().snapshot().player,
        airborne: true,
        previousYM: 12,
        yM: 10,
        previousZM: -5,
        absoluteZM: 5,
      };
      const item = pickup(
        kind,
        0,
        kind === 'boing' ? 1.2 : kind === 'shield' ? 3.4 : 4.8,
      );
      expect(collectsBooster(player, item)).toBe(true);
      expect(collectsBooster(player, { ...item, lane: 2 })).toBe(false);
      expect(collectsBooster(player, { ...item, absoluteZM: 10 })).toBe(false);
    },
  );

  it('requires the jump height and horizontal passage to overlap in time', () => {
    const player = emptyRun().snapshot().player;
    const item = pickup('rocket', 0, 4.8);
    expect(
      collectsBooster(
        {
          ...player,
          airborne: true,
          previousZM: 0,
          absoluteZM: 20,
          previousYM: 0,
          yM: 10,
        },
        item,
      ),
    ).toBe(false);
    expect(
      collectsBooster(
        { ...player, previousZM: -20, absoluteZM: 0, previousYM: 10, yM: 0 },
        item,
      ),
    ).toBe(false);
    expect(
      collectsBooster(
        {
          ...player,
          airborne: true,
          previousZM: -10,
          absoluteZM: 10,
          previousYM: 0,
          yM: 10,
        },
        item,
      ),
    ).toBe(true);
  });

  it.each(['boing', 'shield', 'rocket'] as const)(
    'collects a %s exactly once when normal or double jumps pass over it',
    (kind) => {
      for (const doubleJump of [false, true]) {
        const run = emptyRun();
        run.__debugSetPlayer({ speedMps: BASE_SPEED_MPS });
        clearTick(run, tap);
        if (doubleJump) {
          run.__debugSetBoosters({ doubleJumpCount: 1 });
          clearTick(run, tap);
        }
        for (let i = 0; i < 24; i += 1) clearTick(run);
        run.drainEvents();
        const item = pickup(
          kind,
          run.renderPlayer.absoluteZM + BASE_SPEED_MPS * FIXED_DT,
          kind === 'boing' ? 1.2 : kind === 'shield' ? 3.4 : 4.8,
        );
        expect(run.renderPlayer.yM + 0.7).toBeGreaterThan(item.yM);
        run.__debugReplacePickups([item]);
        clearTick(run);
        expect(
          run.renderPickups.some((candidate) => candidate.id === item.id),
        ).toBe(false);
        const boosts = run.renderBoosters;
        if (kind === 'boing') expect(boosts.doubleJumpCount).toBe(1);
        if (kind === 'shield') expect(boosts.shieldCount).toBe(1);
        if (kind === 'rocket') expect(boosts.rocket).not.toBeNull();
        clearTick(run);
        expect(
          run
            .drainEvents()
            .filter((event) => event.type === 'pickup' && event.kind === kind),
        ).toHaveLength(1);
      }
    },
  );

  it('stacks each pickup once, preserves snapshots and pause state, and clears inventory on restart', () => {
    const run = emptyRun();
    const initial = run.snapshot();
    for (let count = 1; count <= 3; count += 1) {
      const z = run.renderPlayer.absoluteZM;
      run.__debugReplacePickups([pickup('boing', z), pickup('shield', z)]);
      clearTick(run);
      clearTick(run);
      expect(run.snapshot().boosters).toMatchObject({
        doubleJumpCount: count,
        shieldCount: count,
      });
      expect(
        run.drainEvents().filter((event) => event.type === 'pickup'),
      ).toHaveLength(2);
    }
    expect(initial.boosters).toMatchObject({
      doubleJumpCount: 0,
      shieldCount: 0,
    });
    run.setPaused(true);
    const paused = run.snapshot();
    for (let i = 0; i < 100; i += 1) run.tick(tap);
    expect(run.snapshot()).toEqual(paused);
    run.restart();
    expect(run.snapshot().boosters).toMatchObject({
      doubleJumpCount: 0,
      shieldCount: 0,
      protectionS: 0,
      rocket: null,
      effect: null,
    });
  });

  it.each(['start', 'restart'] as const)(
    'does not carry unused charges through game-over into %s',
    (nextRun) => {
      const run = emptyRun();
      run.__debugSetBoosters({ doubleJumpCount: 4 });
      run.__debugReplaceTraffic([
        createTrafficVehicle('last-hit', 'test', 'bus', 'ordinary', 1, 0, 0),
      ]);
      run.tick(drive);
      expect(run.phaseName).toBe('game-over');
      expect(run.renderBoosters.doubleJumpCount).toBe(4);
      run[nextRun]();
      expect(run.phaseName).toBe('running');
      expect(run.renderBoosters).toMatchObject({
        doubleJumpCount: 0,
        shieldCount: 0,
        rocket: null,
      });
    },
  );

  it('retains only a bounded live pickup window through 100 km of forward progress', () => {
    const run = emptyRun();
    for (let distance = 0; distance < 100_000; distance += 100) {
      run.__debugSetPlayer({
        absoluteZM: distance,
        previousZM: distance,
        maxForwardM: distance,
        speedMps: BASE_SPEED_MPS,
      });
      clearTick(run);
      expect(run.renderPickups.length).toBeLessThanOrEqual(BOOSTER_POOL_SIZE);
      expect(
        run.renderPickups.every((item) => item.absoluteZM > distance - 6),
      ).toBe(true);
    }
  });
});

describe('Boing! double jump', () => {
  it('keeps held auto-hop and key repeat from consuming a charge, but accepts a second tap between ticks', () => {
    const run = emptyRun();
    run.__debugSetBoosters({ doubleJumpCount: 1 });
    const keys = new InputBuffer();
    keys.keyDown('Space');
    clearTick(run, keys.consume());
    for (let tick = 0; tick < 30; tick += 1) {
      keys.keyDown('Space', true);
      clearTick(run, keys.consume());
    }
    expect(run.snapshot().boosters.doubleJumpCount).toBe(1);
    keys.keyUp('Space');
    keys.keyDown('Space');
    keys.keyUp('Space');
    const height = run.renderPlayer.yM;
    clearTick(run, keys.consume());
    expect(run.renderPlayer.yM).toBeGreaterThan(height);
    expect(run.renderPlayer.verticalSpeedMps).toBeGreaterThan(
      DOUBLE_JUMP_IMPULSE_MPS - 1,
    );
    expect(run.snapshot().boosters.doubleJumpCount).toBe(0);
    expect(
      run.drainEvents().filter((event) => event.type === 'double-jump'),
    ).toHaveLength(1);
  });

  it.each([2, 25, 49])(
    'refreshes upward velocity and gives over 1.6 seconds of airtime at jump tick %i',
    (jumpTick) => {
      const run = emptyRun();
      run.__debugSetBoosters({ doubleJumpCount: 1 });
      clearTick(run, tap);
      for (let i = 1; i < jumpTick; i += 1) clearTick(run);
      const height = run.renderPlayer.yM;
      clearTick(run, tap);
      expect(run.renderPlayer.yM).toBeGreaterThan(height);
      let ticks = 0;
      while (run.renderPlayer.airborne && ticks < 180) {
        clearTick(run);
        ticks += 1;
      }
      expect(ticks * FIXED_DT).toBeGreaterThan(1.6);
      expect(run.renderPlayer.yM).toBe(0);
      expect(run.renderPlayer.speedMps).toBeCloseTo(START_SPEED_MPS, 8);
      expect(run.phaseName).toBe('running');
    },
  );

  it('cannot triple jump, even if a second spring is collected in flight', () => {
    const run = emptyRun();
    run.__debugSetBoosters({ doubleJumpCount: 3 });
    clearTick(run, tap);
    clearTick(run, tap);
    expect(run.renderBoosters.doubleJumpCount).toBe(2);
    for (let i = 0; i < 10; i += 1) clearTick(run, tap);
    expect(run.renderBoosters.doubleJumpCount).toBe(2);
    run.__debugReplacePickups([pickup('boing', run.renderPlayer.absoluteZM)]);
    clearTick(run, tap);
    expect(
      run.drainEvents().filter((event) => event.type === 'double-jump'),
    ).toHaveLength(1);
    expect(run.snapshot().boosters.doubleJumpCount).toBe(3);
    while (run.renderPlayer.airborne) clearTick(run);
    clearTick(run, tap);
    clearTick(run, tap);
    expect(run.renderBoosters.doubleJumpCount).toBe(2);
    expect(
      run.drainEvents().filter((event) => event.type === 'double-jump'),
    ).toHaveLength(1);
  });

  it('spends stacked charges one per flight until empty without going negative', () => {
    const run = emptyRun();
    run.__debugSetBoosters({ doubleJumpCount: 3 });
    for (let flight = 0; flight < 4; flight += 1) {
      run.drainEvents();
      clearTick(run, tap);
      clearTick(run, tap);
      expect(run.renderBoosters.doubleJumpCount).toBe(Math.max(0, 2 - flight));
      expect(
        run.drainEvents().filter((event) => event.type === 'double-jump'),
      ).toHaveLength(flight < 3 ? 1 : 0);
      let ticks = 0;
      while (run.renderPlayer.airborne && ticks++ < 240) clearTick(run);
      expect(run.renderPlayer.airborne).toBe(false);
    }
  });

  it('uses the boosted altitude for collision detection when jumping a bus', () => {
    const run = emptyRun();
    run.__debugSetBoosters({ doubleJumpCount: 1 });
    clearTick(run, tap);
    for (let i = 0; i < 25; i += 1) clearTick(run);
    clearTick(run, tap);
    for (let i = 0; i < 25; i += 1) clearTick(run);
    run.__debugReplaceTraffic([
      createTrafficVehicle(
        'under-bus',
        'test',
        'bus',
        'ordinary',
        1,
        run.renderPlayer.absoluteZM,
        0,
      ),
    ]);
    run.tick(drive);
    expect(run.renderPlayer.yM).toBeGreaterThan(8);
    expect(run.phaseName).toBe('running');
  });
});

describe('Bubble Buddy', () => {
  it('spends one stacked shield per impact, preserves the next through grace, then runs out', () => {
    const run = emptyRun();
    run.__debugSetBoosters({ shieldCount: 2 });
    const hit = () => {
      const z = run.renderPlayer.absoluteZM;
      run.__debugReplaceTraffic([
        createTrafficVehicle('bonk-car', 'test', 'sedan', 'ordinary', 1, z, 0),
        createTrafficVehicle(
          'bonk-bus',
          'test',
          'bus',
          'ordinary',
          1,
          z + 1,
          0,
        ),
      ]);
      run.tick(drive);
    };
    for (const remaining of [1, 0]) {
      hit();
      expect(run.phaseName).toBe('running');
      expect(run.renderBoosters.shieldCount).toBe(remaining);
      expect(
        run.drainEvents().filter((event) => event.type === 'shield-pop'),
      ).toHaveLength(1);
      hit();
      expect(run.renderBoosters.shieldCount).toBe(remaining);
      expect(
        run.drainEvents().filter((event) => event.type === 'shield-pop'),
      ).toHaveLength(0);
      for (let i = 0; i < Math.ceil(SHIELD_GRACE_S / FIXED_DT) + 1; i += 1)
        clearTick(run);
    }
    hit();
    expect(run.phaseName).toBe('game-over');
    expect(run.renderBoosters.shieldCount).toBe(0);
    expect(
      run.drainEvents().filter((event) => event.type === 'crash'),
    ).toHaveLength(1);
  });
  it('absorbs one multi-car contact, clears those colliders, then lets the next crash end the run', () => {
    const run = emptyRun();
    run.__debugSetBoosters({ shieldCount: 1 });
    run.__debugReplaceTraffic([
      createTrafficVehicle('bonk-1', 'test', 'sedan', 'ordinary', 1, 0, 0),
      createTrafficVehicle('bonk-2', 'test', 'bus', 'ordinary', 1, 1, 0),
    ]);
    run.tick(EMPTY_INPUT);
    expect(run.phaseName).toBe('running');
    expect(run.snapshot().boosters).toMatchObject({
      shieldCount: 0,
      protectionS: SHIELD_GRACE_S,
    });
    expect(
      run.renderTraffic.some((vehicle) => vehicle.id.startsWith('bonk')),
    ).toBe(false);
    expect(run.snapshot().bonusScore).toBe(0);
    expect(
      run.drainEvents().filter((event) => event.type === 'shield-pop'),
    ).toHaveLength(1);
    for (let i = 0; i < 100; i += 1) run.tick(EMPTY_INPUT);
    expect(run.phaseName).toBe('running');
    run.__debugReplaceTraffic([
      createTrafficVehicle(
        'second-hit',
        'test',
        'sedan',
        'ordinary',
        1,
        run.renderPlayer.absoluteZM,
        0,
      ),
    ]);
    run.tick(EMPTY_INPUT);
    expect(run.phaseName).toBe('game-over');
  });

  it('blocks another contact during recovery and freezes the timer while paused', () => {
    const run = emptyRun();
    run.__debugSetBoosters({ shieldCount: 1 });
    run.__debugReplaceTraffic([
      createTrafficVehicle('hit', 'test', 'sedan', 'ordinary', 1, 0, 0),
    ]);
    run.tick(EMPTY_INPUT);
    run.setPaused(true);
    const paused = run.snapshot();
    for (let i = 0; i < 600; i += 1) run.tick(tap);
    expect(run.snapshot()).toEqual(paused);
    run.setPaused(false);
    run.__debugReplaceTraffic([
      createTrafficVehicle('grace-hit', 'test', 'sedan', 'ordinary', 1, 0, 0),
    ]);
    run.tick(EMPTY_INPUT);
    expect(run.phaseName).toBe('running');
  });
});

describe('Yeet Rocket', () => {
  const flightTicks = Math.round(ROCKET_DURATION_S / FIXED_DT);

  function launchRocket(seed = 17) {
    const run = emptyRun(seed);
    const startM = 127;
    run.__debugSetPlayer({
      absoluteZM: startM,
      previousZM: startM,
      maxForwardM: startM,
    });
    run.__debugReplacePickups([pickup('rocket', startM)]);
    run.tick(drive);
    return run;
  }

  it.each([0, 17, 55, 444])(
    'keeps its speed, height, duration and inventory while steering through active lanes (seed %i)',
    (seed) => {
      const run = launchRocket(seed);
      run.__debugSetBoosters({ doubleJumpCount: 3, shieldCount: 2 });
      const launch = run.snapshot();
      expect(launch.boosters.rocket).not.toBeNull();
      let maxHeight = 0;
      for (let i = 0; i < flightTicks; i += 1) {
        clearTick(run, { ...tap, laneDelta: -1 });
        maxHeight = Math.max(maxHeight, run.renderPlayer.yM);
        expect(run.phaseName).toBe('running');
        expect(hasLane(run.snapshot().laneMask, run.renderPlayer.lane)).toBe(
          true,
        );
      }
      const after = run.snapshot();
      expect(maxHeight).toBeGreaterThanOrEqual(ROCKET_HEIGHT_M - 0.1);
      expect(after.player.absoluteZM - launch.player.absoluteZM).toBeCloseTo(
        ROCKET_DISTANCE_M,
        6,
      );
      expect(after.boosters.rocket).toBeNull();
      expect(after.player).toMatchObject({
        airborne: false,
        yM: 0,
        speedMps: START_SPEED_MPS,
      });
      expect(hasLane(after.laneMask, after.player.lane)).toBe(true);
      expect(after.boosters).toMatchObject({
        doubleJumpCount: 3,
        shieldCount: 2,
        protectionS: 0,
      });
      expect(after.bonusScore).toBeGreaterThanOrEqual(ROCKET_BONUS);
      expect(
        run.drainEvents().filter((event) => event.type === 'rocket-land'),
      ).toHaveLength(1);
      const previousLane = run.renderPlayer.lane;
      clearTick(run, { ...drive, laneDelta: previousLane <= 1 ? 1 : -1 });
      // A flip still in progress at touchdown finishes before a queued turn.
      for (let i = 0; i < LANE_CHANGE_TICKS; i += 1) clearTick(run);
      expect(run.renderPlayer.lane).not.toBe(previousLane);
    },
  );

  it.each(['sedan', 'bus'] as const)(
    'poofs a %s during descent and awards the landing',
    (kind) => {
      const run = launchRocket();
      const landingM = run.renderBoosters.rocket!.landingZM;
      run.__debugReplaceTraffic([
        createTrafficVehicle(
          'landing-hit',
          'test',
          kind,
          'ordinary',
          1,
          landingM,
          0,
        ),
      ]);
      for (let i = 0; i < flightTicks && run.phaseName === 'running'; i += 1)
        run.tick(drive);
      expect(run.phaseName).toBe('running');
      expect(run.renderBoosters.rocket).toBeNull();
      expect(run.renderPlayer.absoluteZM).toBeCloseTo(landingM);
      expect(
        run.renderTraffic.some((vehicle) => vehicle.id === 'landing-hit'),
      ).toBe(false);
      const events = run.drainEvents();
      expect(events.filter((event) => event.type === 'crash')).toHaveLength(0);
      expect(
        events.filter((event) => event.type === 'landing-poof'),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === 'rocket-land'),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === 'bonus' && event.points === ROCKET_BONUS,
        ),
      ).toHaveLength(1);
    },
  );

  it('lets the player evade landing traffic and keeps nearby cars and collisions after touchdown', () => {
    const run = launchRocket();
    const landingM = run.renderBoosters.rocket!.landingZM;
    run.__debugReplaceTraffic([
      createTrafficVehicle(
        'landing-bus',
        'test',
        'bus',
        'gate',
        1,
        landingM,
        0,
      ),
      createTrafficVehicle(
        'nearby-suv',
        'test',
        'suv',
        'ordinary',
        1,
        landingM + 25,
        0,
      ),
    ]);
    for (let i = 0; i < flightTicks; i += 1)
      run.tick({ ...drive, laneDelta: i === 180 ? 1 : 0 });
    expect(run.phaseName).toBe('running');
    expect(run.renderPlayer.lane).toBe(2);
    expect(run.renderBoosters).toMatchObject({ rocket: null, protectionS: 0 });
    expect(
      run.renderTraffic.find((vehicle) => vehicle.id === 'landing-bus')
        ?.absoluteZM,
    ).toBe(landingM);
    expect(
      run.renderTraffic.find((vehicle) => vehicle.id === 'nearby-suv')
        ?.absoluteZM,
    ).toBe(landingM + 25);
    expect(
      run.drainEvents().filter((event) => event.type === 'rocket-land'),
    ).toHaveLength(1);
    run.__debugReplaceTraffic([
      createTrafficVehicle(
        'after-touchdown',
        'test',
        'sedan',
        'ordinary',
        2,
        landingM + 3,
        0,
      ),
    ]);
    run.tick(drive);
    expect(run.phaseName).toBe('game-over');
  });

  it('preserves Bubble Buddy when landing traffic is poofed away', () => {
    const run = launchRocket();
    run.__debugSetBoosters({ shieldCount: 2 });
    run.__debugReplaceTraffic([
      createTrafficVehicle(
        'shield-hit',
        'test',
        'bus',
        'ordinary',
        1,
        run.renderBoosters.rocket!.landingZM,
        0,
      ),
    ]);
    for (let i = 0; i < flightTicks; i += 1) run.tick(drive);
    expect(run.phaseName).toBe('running');
    expect(run.renderBoosters.shieldCount).toBe(2);
    expect(
      run.drainEvents().filter((event) => event.type === 'shield-pop'),
    ).toHaveLength(0);
  });

  it('uses identical lane movement, queued reversals and barrel-roll poses to a normal jump', () => {
    const rocket = launchRocket();
    for (let i = 0; i < 100; i += 1) clearTick(rocket);
    const jump = emptyRun();
    clearTick(jump, tap);
    for (let i = 0; i < LANE_CHANGE_TICKS * 2 + 1; i += 1) {
      const input: InputFrame = {
        ...drive,
        laneDelta: i === 0 ? 1 : i === 2 ? -1 : 0,
      };
      clearTick(rocket, input);
      clearTick(jump, input);
      expect(rocket.renderPlayer.xM).toBe(jump.renderPlayer.xM);
      expect(rocket.renderPlayer.previousXM).toBe(jump.renderPlayer.previousXM);
      expect(rocket.renderPlayer.queuedLane).toBe(jump.renderPlayer.queuedLane);
      for (const alpha of [0, 0.4, 1])
        expect(laneChangeAnimationPose(rocket.renderPlayer, alpha)).toEqual(
          laneChangeAnimationPose(jump.renderPlayer, alpha),
        );
      if (i === LANE_CHANGE_TICKS / 2 - 1)
        expect(
          laneChangeAnimationPose(rocket.renderPlayer, 1).rollRad,
        ).toBeCloseTo(-Math.PI, 8);
    }
    expect(rocket.renderPlayer.lane).toBe(1);
    expect(rocket.renderPlayer.airborne).toBe(true);
  });

  it('preserves lane flips already in progress at pickup and at touchdown', () => {
    const run = emptyRun();
    run.__debugReplacePickups([pickup('rocket')]);
    clearTick(run, { ...drive, laneDelta: 1 });
    expect(run.renderBoosters.rocket).not.toBeNull();
    expect(run.renderPlayer.laneChangeDirection).toBe(1);
    expect(run.renderPlayer.laneChangeElapsedS).toBe(FIXED_DT);
    for (let i = 0; i < flightTicks - 4; i += 1) clearTick(run);
    for (let i = 0; i < 4; i += 1)
      clearTick(run, { ...drive, laneDelta: i === 0 ? -1 : i === 1 ? 1 : 0 });
    expect(run.renderBoosters.rocket).toBeNull();
    expect(run.renderPlayer).toMatchObject({
      airborne: false,
      lane: 1,
      laneChangeDirection: -1,
      queuedLane: 2,
    });
    expect(run.renderPlayer.laneChangeElapsedS).toBeCloseTo(4 * FIXED_DT, 8);
    for (let i = 4; i < LANE_CHANGE_TICKS * 2; i += 1) clearTick(run);
    expect(run.renderPlayer).toMatchObject({
      lane: 2,
      xM: LANE_X[2],
      laneChangeDirection: 0,
      queuedLane: null,
    });
  });

  it.each([0, 17, 55, 444])(
    'keeps natural traffic near touchdown with steerable routes and no visible spawns (seed %i)',
    (seed) => {
      const run = launchRocket(seed);
      const seenIds = new Set(run.renderTraffic.map((vehicle) => vehicle.id));
      let newCars = 0;
      let steered = false;
      for (let i = 0; i < flightTicks; i += 1) {
        const input = certificateBotInput(run, run.snapshot());
        steered ||= input.laneDelta !== 0;
        run.tick(input);
        expect(run.phaseName).toBe('running');
        for (const vehicle of run.renderTraffic) {
          if (seenIds.has(vehicle.id)) continue;
          expect(
            vehicle.absoluteZM - run.renderPlayer.absoluteZM,
          ).toBeGreaterThan(TRAFFIC_RENDER_AHEAD_M);
          seenIds.add(vehicle.id);
          newCars += 1;
        }
      }
      expect(newCars).toBeGreaterThan(0);
      expect(steered).toBe(true);
      expect(
        run.renderTraffic.some(
          (vehicle) =>
            vehicle.absoluteZM >= run.renderPlayer.absoluteZM &&
            vehicle.absoluteZM < run.renderPlayer.absoluteZM + 90,
        ),
      ).toBe(true);
      expect(run.renderBoosters).toMatchObject({
        rocket: null,
        shieldCount: 0,
        protectionS: 0,
      });
    },
  );

  it('replays an in-flight traffic proof through touchdown using the actual rocket arc', () => {
    const run = launchRocket();
    // Capture the last certificate born on a tick during the second half of
    // flight, so its proof must cover both rocket descent and normal driving.
    for (let i = 0; i < flightTicks - 1; i += 1) {
      run.tick(certificateBotInput(run, run.snapshot()));
      const certificate = run
        .getGroundCertificates()
        .filter((candidate) => candidate.revealTick === run.renderTick)
        .at(-1);
      if (!certificate || run.renderBoosters.rocket!.elapsedS < 2) continue;
      const snapshot = run.snapshot();
      const replay = emptyRun();
      replay.__debugSetPlayer(snapshot.player);
      replay.__debugSetBoosters(snapshot.boosters);
      replay.__debugReplaceTraffic(snapshot.traffic);
      const trafficIds = new Set(snapshot.traffic.map((vehicle) => vehicle.id));
      const trace = new Map(
        certificate.witness.map((point) => [point.tick, point]),
      );
      let checkedGrounded = false;
      for (
        let tick = certificate.revealTick;
        tick <= certificate.witness.at(-1)!.tick;
        tick += 1
      ) {
        // Isolate the certified world from later, independently proved rows.
        replay.__debugReplaceTraffic(
          replay.renderTraffic.filter((vehicle) => trafficIds.has(vehicle.id)),
        );
        replay.__debugReplacePickups([]);
        const point = trace.get(tick);
        replay.tick(point?.input ?? drive);
        expect(replay.phaseName).toBe('running');
        if (!point) continue;
        expect(Math.round(replay.renderPlayer.xM * 1000)).toBe(point.xMM);
        expect(Math.round(replay.renderPlayer.yM * 1000)).toBe(point.yMM);
        expect(Math.round(replay.renderPlayer.absoluteZM * 1000)).toBe(
          point.zMM,
        );
        expect(Math.round(replay.renderPlayer.speedMps * 1000)).toBe(
          point.speedMMps,
        );
        checkedGrounded ||= !replay.renderPlayer.airborne;
      }
      expect(checkedGrounded).toBe(true);
      return;
    }
    throw new Error('No in-flight traffic certificate was generated');
  });

  it('pauses mid-flight without moving, consuming inventory or awarding the landing twice', () => {
    const run = emptyRun();
    run.__debugReplacePickups([pickup('rocket')]);
    run.tick(EMPTY_INPUT);
    for (let i = 0; i < 100; i += 1) run.tick(drive);
    run.tick({ ...drive, laneDelta: 1 });
    run.setPaused(true);
    const snapshot = run.snapshot();
    for (let i = 0; i < 100; i += 1) run.tick(tap);
    expect(run.snapshot()).toEqual(snapshot);
    run.setPaused(false);
    for (let i = 0; i < 160; i += 1)
      run.tick(certificateBotInput(run, run.snapshot()));
    expect(
      run.drainEvents().filter((event) => event.type === 'rocket-land'),
    ).toHaveLength(1);
  });

  it.each(['boing', 'shield', 'rocket'] as const)(
    'skips %s pickups throughout Yeet, including its touchdown segment',
    (kind) => {
      const run = launchRocket();
      const flight = { ...run.renderBoosters.rocket! };
      run.drainEvents();
      for (let tick = 1; tick <= flightTicks; tick += 1) {
        const nextZM =
          flight.startZM + (ROCKET_DISTANCE_M * tick) / flightTicks;
        // The final pickup intersects only the flight's final swept segment,
        // so collection on the next grounded tick cannot hide a Yeet pickup.
        const item = pickup(
          kind,
          tick === flightTicks ? flight.landingZM - 2.5 : nextZM,
        );
        run.__debugReplacePickups([item]);
        clearTick(run);
        expect(
          run.renderPickups.some((candidate) => candidate.id === item.id),
        ).toBe(true);
      }
      expect(run.renderBoosters).toMatchObject({
        doubleJumpCount: 0,
        shieldCount: 0,
        rocket: null,
      });
      expect(
        run.drainEvents().filter((event) => event.type === 'pickup'),
      ).toHaveLength(0);
      // Grounded pickup contact works again immediately after the flight.
      run.__debugReplacePickups([pickup('boing', run.renderPlayer.absoluteZM)]);
      clearTick(run);
      expect(run.renderBoosters.doubleJumpCount).toBe(1);
      expect(
        run.drainEvents().filter((event) => event.type === 'pickup'),
      ).toHaveLength(1);
    },
  );

  it('replays booster state identically at 30, 60 and 144 Hz', () => {
    const run = (hz: number) => {
      const simulation = emptyRun();
      simulation.__debugReplacePickups([pickup('rocket')]);
      return runRenderSchedule(
        simulation,
        Array.from({ length: hz * 5 }, () => 1 / hz),
        () => certificateBotInput(simulation, simulation.snapshot()),
      );
    };
    expect(run(30)).toBe(run(60));
    expect(run(144)).toBe(run(60));
  });
});
