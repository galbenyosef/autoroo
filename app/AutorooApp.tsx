'use client';

import dynamic from 'next/dynamic';
import Image from 'next/image';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefAttributes,
} from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import {
  Pause,
  Play,
  RotateCcw,
  Star,
  Volume2,
  VolumeX,
  ChevronsUp,
} from 'lucide-react';
import { makeBoosterState } from './game/boosters';
import { CreditsDialog } from './CreditsDialog';
import { BoosterHud } from './game/BoosterHud';
import { YeetBurst, useYeetBurst } from './game/YeetBurst';
import { FIXED_DT, LANE_X, countLanes } from './game/constants';
import { laneMaskAt } from './game/generator';
import type { GameEvent, RunSnapshot } from './game/contracts';
import type { GameCanvasHandle, GameCanvasProps } from './game/GameCanvas';
import {
  createDoubleJumpHintClaim,
  loadBest,
  saveBest,
} from './game/persistence';
import { TouchControls, TOUCH_CONTROLS_QUERY } from './game/TouchControls';
import type { DrivingControl } from './game/input';

const GameCanvas = dynamic<GameCanvasProps & RefAttributes<GameCanvasHandle>>(
  () => import('./game/GameCanvas'),
  {
    ssr: false,
    loading: () => <div className="game-loading">Warming up the road…</div>,
  },
);

const INITIAL_SEED = 0xa770_2026;
const INITIAL_LANE_MASK = laneMaskAt(INITIAL_SEED, 0);

const INITIAL_SNAPSHOT: RunSnapshot = {
  version: 1,
  seed: INITIAL_SEED,
  tick: 0,
  phase: 'ready',
  elapsedS: 0,
  player: {
    lane: 1,
    xM: LANE_X[1],
    previousXM: LANE_X[1],
    laneChangeStartXM: LANE_X[1],
    laneChangeElapsedS: 0,
    laneChangeDirection: 0,
    queuedLane: null,
    absoluteZM: 0,
    previousZM: 0,
    yM: 0,
    previousYM: 0,
    speedMps: 0,
    verticalSpeedMps: 0,
    airborne: false,
    takeoffSpeedMps: 0,
    jumpElapsedS: 0,
    maxForwardM: 0,
  },
  traffic: [],
  pickups: [],
  boosters: makeBoosterState(),
  score: 0,
  bonusScore: 0,
  difficulty: 0,
  laneMask: INITIAL_LANE_MASK,
  laneCount: countLanes(INITIAL_LANE_MASK),
  activeCertificate: null,
  lastBonusLabel: null,
};

function formatScore(score: number): string {
  return Math.max(0, Math.floor(score)).toString().padStart(6, '0');
}

function statusPayload(snapshot: RunSnapshot, best: number) {
  return {
    phase: snapshot.phase,
    score: snapshot.score,
    best,
    distanceMetres: Math.floor(snapshot.player.maxForwardM),
    speedMetresPerSecond: Number(snapshot.player.speedMps.toFixed(2)),
    lane: snapshot.player.lane + 1,
    activeLanes: snapshot.laneCount,
    jumpGateVisible: snapshot.activeCertificate?.kind === 'jump',
    doubleJumpReady: snapshot.boosters.doubleJumpCount > 0,
    shieldReady: snapshot.boosters.shieldCount > 0,
    doubleJumpCount: snapshot.boosters.doubleJumpCount,
    shieldCount: snapshot.boosters.shieldCount,
    rocketActive: snapshot.boosters.rocket !== null,
  };
}

export function AutorooApp() {
  const gameRef = useRef<GameCanvasHandle>(null);
  const snapshotRef = useRef<RunSnapshot>(INITIAL_SNAPSHOT);
  const bestRef = useRef(0);
  const claimDoubleJumpHintRef = useRef<(() => boolean) | null>(null);
  const scoreDeltaTimerRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);
  const [best, setBest] = useState(0);
  const [sceneReady, setSceneReady] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [muted, setMuted] = useState(false);
  const [scoreDelta, setScoreDelta] = useState(0);
  const [doubleJumpHintUntilTick, setDoubleJumpHintUntilTick] = useState<
    number | null
  >(null);
  const [touchDriving, setTouchDriving] = useState(false);
  const [crashAnimating, setCrashAnimating] = useState(false);
  const {
    burstId: yeetBurstId,
    play: playYeetBurst,
    clear: clearYeetBurst,
  } = useYeetBurst();

  useEffect(() => {
    const query = window.matchMedia(TOUCH_CONTROLS_QUERY);
    const update = () => setTouchDriving(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    gameRef.current?.setTouchDriving(touchDriving);
  }, [touchDriving, sceneReady]);

  const onControlPress = useCallback(
    (control: DrivingControl, source: string) => {
      gameRef.current?.controlDown(control, source);
    },
    [],
  );
  const onControlRelease = useCallback((source: string) => {
    gameRef.current?.controlUp(source);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = loadBest();
      bestRef.current = stored;
      setBest(stored);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    return () => {
      if (scoreDeltaTimerRef.current !== null)
        window.clearTimeout(scoreDeltaTimerRef.current);
    };
  }, []);

  const clearScoreDelta = useCallback(() => {
    if (scoreDeltaTimerRef.current !== null) {
      window.clearTimeout(scoreDeltaTimerRef.current);
      scoreDeltaTimerRef.current = null;
    }
    setScoreDelta(0);
  }, []);

  const onSnapshot = useCallback(
    (next: RunSnapshot) => {
      const previousPhase = snapshotRef.current.phase;
      if (next.phase !== 'running' || next.tick < snapshotRef.current.tick)
        clearYeetBurst();
      if (next.phase !== 'game-over') setCrashAnimating(false);
      if (next.tick < snapshotRef.current.tick || next.phase === 'game-over')
        setDoubleJumpHintUntilTick(null);
      snapshotRef.current = next;
      setSnapshot(next);
      if (previousPhase === 'running' && next.phase !== 'running')
        clearScoreDelta();
      if (next.score > bestRef.current) {
        bestRef.current = next.score;
        setBest(next.score);
      }
      if (next.phase === 'game-over' && next.score > loadBest())
        saveBest(next.score);
    },
    [clearScoreDelta, clearYeetBurst],
  );

  const onEvent = useCallback(
    (event: GameEvent) => {
      if (event.type === 'rocket-launch') playYeetBurst();
      if (event.type === 'crash') setCrashAnimating(true);
      if (event.type === 'pickup' && event.kind === 'boing') {
        // Consume the actual pickup event: a charge can be spent between HUD
        // snapshots. Initialize storage lazily, and keep this callback stable.
        claimDoubleJumpHintRef.current ??= createDoubleJumpHintClaim();
        if (claimDoubleJumpHintRef.current()) {
          const tick =
            gameRef.current?.snapshot()?.tick ?? snapshotRef.current.tick;
          setDoubleJumpHintUntilTick(tick + Math.round(3.5 / FIXED_DT));
        }
      }
      if (event.type !== 'bonus') return;
      setScoreDelta((current) => current + event.points);
      if (scoreDeltaTimerRef.current !== null)
        window.clearTimeout(scoreDeltaTimerRef.current);
      scoreDeltaTimerRef.current = window.setTimeout(() => {
        scoreDeltaTimerRef.current = null;
        setScoreDelta(0);
      }, 900);
    },
    [playYeetBurst],
  );

  const onReady = useCallback(() => setSceneReady(true), []);
  const onCrashAnimationComplete = useCallback(
    () => setCrashAnimating(false),
    [],
  );
  const onLoadProgress = useCallback(
    (progress: number) => setLoadProgress(progress),
    [],
  );

  const startRun = useCallback(() => {
    clearScoreDelta();
    gameRef.current?.setTouchDriving(touchDriving);
    gameRef.current?.start();
  }, [clearScoreDelta, touchDriving]);

  const restartRun = useCallback(() => {
    clearScoreDelta();
    gameRef.current?.restart();
  }, [clearScoreDelta]);

  const setPauseState = useCallback((paused: boolean) => {
    gameRef.current?.setPaused(paused);
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      gameRef.current?.setMuted(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Parameters<typeof context.registerTool>[0]) => {
      try {
        void Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch((error) =>
          console.warn('[Autoroo WebMCP] Registration failed', error),
        );
      } catch (error) {
        console.warn('[Autoroo WebMCP] Registration failed', error);
      }
    };

    register({
      name: 'read_autoroo_run_status',
      title: 'Read Autoroo run status',
      description: 'Read the same current run status shown in the Autoroo HUD.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute() {
        return statusPayload(snapshotRef.current, bestRef.current);
      },
    });
    register({
      name: 'start_autoroo_run',
      title: 'Start Autoroo run',
      description:
        'Start the ready Autoroo run, equivalent to the visible GO! button.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute() {
        if (snapshotRef.current.phase !== 'ready')
          throw new Error('The run is not on the start screen.');
        if (!gameRef.current?.isReady())
          throw new Error('The game is still loading.');
        startRun();
        return statusPayload(
          gameRef.current?.snapshot() ?? snapshotRef.current,
          bestRef.current,
        );
      },
    });
    register({
      name: 'set_autoroo_pause_state',
      title: 'Set Autoroo pause state',
      description:
        'Pause or resume the active run, equivalent to the visible pause controls.',
      inputSchema: {
        type: 'object',
        properties: { paused: { type: 'boolean' } },
        required: ['paused'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (
          typeof input !== 'object' ||
          input === null ||
          typeof (input as { paused?: unknown }).paused !== 'boolean'
        ) {
          throw new Error('paused must be a boolean.');
        }
        if (!['running', 'paused'].includes(snapshotRef.current.phase)) {
          throw new Error('There is no active run to pause or resume.');
        }
        setPauseState((input as { paused: boolean }).paused);
        return statusPayload(
          gameRef.current?.snapshot() ?? snapshotRef.current,
          bestRef.current,
        );
      },
    });
    register({
      name: 'restart_autoroo_run',
      title: 'Restart Autoroo run',
      description:
        'Restart after a crash, equivalent to the visible Drive again button.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute() {
        if (snapshotRef.current.phase !== 'game-over')
          throw new Error('Restart is available after a crash.');
        restartRun();
        return statusPayload(
          gameRef.current?.snapshot() ?? snapshotRef.current,
          bestRef.current,
        );
      },
    });
    return () => lifecycle.abort();
  }, [restartRun, setPauseState, startRun]);

  const isPlaying = snapshot.phase === 'running';
  const isOnStartScreen = snapshot.phase === 'ready';

  return (
    <main
      className="autoroo-shell"
      data-phase={snapshot.phase}
      data-touch={touchDriving}
    >
      <GameCanvas
        ref={gameRef}
        muted={muted}
        onReady={onReady}
        onLoadProgress={onLoadProgress}
        onSnapshot={onSnapshot}
        onEvent={onEvent}
        onCrashAnimationComplete={onCrashAnimationComplete}
      />

      {isPlaying && <YeetBurst burstId={yeetBurstId} />}

      {!isOnStartScreen && (
        <>
          <div className="hud-top" aria-label="Game status">
            <div className="score-chip">
              <div className="score-chip-label">
                <span>SCORE</span>
                {scoreDelta > 0 && (
                  <output className="score-delta" aria-hidden="true">
                    +{scoreDelta}
                  </output>
                )}
              </div>
              <strong>{formatScore(snapshot.score)}</strong>
            </div>
            <Button
              className="hud-icon-button"
              variant="ghost"
              size="icon"
              aria-label={muted ? 'Unmute sound' : 'Mute sound'}
              onClick={toggleMuted}
            >
              {muted ? <VolumeX /> : <Volume2 />}
            </Button>
            {isPlaying && (
              <Button
                className="hud-icon-button"
                variant="ghost"
                size="icon"
                aria-label="Pause game"
                onClick={() => setPauseState(true)}
              >
                <Pause />
              </Button>
            )}
            <BoosterHud
              doubleJumpCount={snapshot.boosters.doubleJumpCount}
              shieldCount={snapshot.boosters.shieldCount}
            />
            <div className="score-chip best-chip">
              <span>PERSONAL BEST</span>
              <strong>{formatScore(best)}</strong>
            </div>
          </div>

          {isPlaying &&
            yeetBurstId === 0 &&
            doubleJumpHintUntilTick !== null &&
            snapshot.tick < doubleJumpHintUntilTick && (
              <output className="booster-notice" aria-live="polite">
                <ChevronsUp aria-hidden="true" />
                Double jump ready! Tap JUMP (or Space) again while airborne.
              </output>
            )}
        </>
      )}

      {isPlaying && touchDriving && (
        <TouchControls onPress={onControlPress} onRelease={onControlRelease} />
      )}

      {isOnStartScreen && (
        <section className="start-screen" aria-labelledby="autoroo-title">
          <div className="start-stage">
            <picture className="start-city">
              <source
                media="(max-aspect-ratio: 4/5)"
                srcSet="/images/menu/autoroo-title-city-portrait.png"
              />
              <Image
                src="/images/menu/autoroo-title-city.png"
                alt=""
                fill
                sizes="100vw"
                priority
                unoptimized
                draggable={false}
              />
            </picture>
            <div className="start-backdrop" aria-hidden="true" />
            <div className="start-stunt" aria-hidden="true">
              <Image
                src="/images/menu/autoroo-stunt-v2.png"
                alt=""
                width={1470}
                height={1070}
                unoptimized
                draggable={false}
              />
            </div>

            <div className="start-best" aria-label={`Personal best: ${best}`}>
              <span>PERSONAL BEST</span>
              <div className="start-best-score">
                <Star fill="currentColor" aria-hidden="true" />
                <strong>{formatScore(best)}</strong>
                <Star fill="currentColor" aria-hidden="true" />
              </div>
            </div>

            <div className="start-utilities">
              <CreditsDialog />
              <Button
                className="start-utility-button start-sound-button"
                variant="ghost"
                size="icon"
                onClick={toggleMuted}
                aria-label={muted ? 'Unmute sound' : 'Mute sound'}
              >
                {muted ? (
                  <VolumeX aria-hidden="true" />
                ) : (
                  <Volume2 aria-hidden="true" />
                )}
              </Button>
            </div>

            <h1 id="autoroo-title" className="sr-only">
              Autoroo
            </h1>
            <p className="start-tagline">
              <span>Endless fun.</span>
              <span>Questionable driving.</span>
            </p>

            <div className="start-launch">
              <Button
                className="start-play-button"
                size="lg"
                aria-keyshortcuts="Space"
                disabled={!sceneReady}
                onClick={startRun}
              >
                <Play fill="currentColor" aria-hidden="true" />
                <span aria-live="polite">
                  {sceneReady
                    ? 'GO!'
                    : `Loading city ${Math.round(loadProgress * 100)}%`}
                </span>
              </Button>
            </div>

            {!touchDriving && (
              <div className="start-controls" aria-label="Keyboard controls">
                <span className="start-control">
                  <span className="start-keys">
                    <Kbd>←</Kbd>
                    <Kbd>→</Kbd>
                  </span>
                  <span>Flip lanes</span>
                </span>
                <span className="start-control">
                  <Kbd className="space-key">Space</Kbd>
                  <span>Jump</span>
                </span>
                <span className="start-control">
                  <span className="start-keys">
                    <Kbd>Esc</Kbd>
                    <span>or</span>
                    <Kbd>P</Kbd>
                  </span>
                  <span>Pause</span>
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {snapshot.phase === 'paused' && (
        <section
          className="overlay-card compact-card"
          aria-labelledby="paused-title"
        >
          <h2 id="paused-title">Paused</h2>
          <Button className="play-button" onClick={() => setPauseState(false)}>
            <Play fill="currentColor" /> Resume
          </Button>
          <p className="key-hint keyboard-hint">
            or press <Kbd>Esc</Kbd> or <Kbd>P</Kbd>
          </p>
        </section>
      )}

      {snapshot.phase === 'game-over' && !crashAnimating && (
        <section
          className="overlay-card crash-card"
          aria-labelledby="crash-title"
        >
          <p className="eyebrow">BONK DETECTED</p>
          <h2 id="crash-title">Road trip over.</h2>
          <div className="crash-score">
            <span>FINAL SCORE</span>
            <strong>{formatScore(snapshot.score)}</strong>
            <small>
              {Math.floor(snapshot.player.maxForwardM)} m driven · +
              {snapshot.bonusScore} bonus
            </small>
          </div>
          <Button className="play-button" onClick={restartRun}>
            <RotateCcw /> Drive again
          </Button>
          <p className="key-hint keyboard-hint">
            press <Kbd>Enter</Kbd> or <Kbd>R</Kbd>
          </p>
        </section>
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {snapshot.phase === 'game-over'
          ? `Game over. Score ${snapshot.score}.`
          : scoreDelta > 0
            ? `Score increased by ${scoreDelta} points.`
            : ''}
      </div>
    </main>
  );
}
