"use client";

import { useEffect, useRef, useState } from "react";
import {
  ENDED_TEXT,
  EXPIRED_TEXT,
  MIC_ERROR_TEXT,
  START_ERROR_TEXT,
  startCallSession,
  type CallSession,
  type CallView,
  type PeerConnectionLike,
} from "@/lib/call/call-session";
import styles from "./call-client.module.css";

export interface CallClientProps {
  token: string;
}

const ALERT_TEXT = {
  mic_error: MIC_ERROR_TEXT,
  expired: EXPIRED_TEXT,
  start_error: START_ERROR_TEXT,
} as const;

/** Phases in which the call is not running and no session handle is held. */
const IDLE_PHASES = new Set<CallView["phase"]>(["mic_error", "expired", "start_error"]);

/**
 * The buyer's call controls. All WebRTC work is in `startCallSession`; this component only wires the
 * tap, the audio element and the state to the screen.
 */
export function CallClient({ token }: CallClientProps) {
  const [view, setView] = useState<CallView | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sessionRef = useRef<CallSession | null>(null);

  // Leaving the page ends a running call (the guarded end is a no-op once it has already run).
  useEffect(() => {
    return () => {
      sessionRef.current?.hangUp();
    };
  }, []);

  function onJoin() {
    const audioEl = audioRef.current;
    // A second tap while a session is running does nothing.
    if (!audioEl || sessionRef.current) return;
    // The mic request and play() happen synchronously inside startCallSession, in this tap handler.
    sessionRef.current = startCallSession({
      token,
      audioEl,
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      // The real RTCPeerConnection has the members CallSession uses; PeerConnectionLike names only those.
      createPeerConnection: () => new RTCPeerConnection() as unknown as PeerConnectionLike,
      fetch: (url, init) => fetch(url, init),
      setInterval: (callback, ms) => window.setInterval(callback, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
      now: () => Date.now(),
      onChange: (next) => {
        if (IDLE_PHASES.has(next.phase)) sessionRef.current = null;
        setView(next);
      },
    });
  }

  function onHangUp() {
    sessionRef.current?.hangUp();
  }

  const phase = view?.phase ?? "ready";
  const showJoin = phase === "ready" || phase === "mic_error" || phase === "start_error";
  const alertText = phase === "mic_error" || phase === "expired" || phase === "start_error" ? ALERT_TEXT[phase] : null;

  return (
    <div className={styles.root}>
      {/* Mobile browsers need autoplay + playsinline for the agent's voice. */}
      <audio ref={audioRef} autoPlay playsInline />

      {showJoin ? (
        <button type="button" className={styles.primary} onClick={onJoin}>
          Join call
        </button>
      ) : null}

      {phase === "connecting" ? (
        <p role="status" className={styles.status}>
          Connecting…
        </p>
      ) : null}

      {phase === "live" ? (
        <div className={styles.live}>
          <p className={styles.countdownLabel}>Time left</p>
          <p role="timer" className={styles.countdown}>
            {view?.countdown ?? ""}
          </p>
          <button type="button" className={styles.hangUp} onClick={onHangUp}>
            Hang up
          </button>
        </div>
      ) : null}

      {phase === "ended" ? (
        <p role="status" className={styles.status}>
          {ENDED_TEXT}
        </p>
      ) : null}

      {alertText ? (
        <p role="alert" className={styles.alert}>
          {alertText}
        </p>
      ) : null}
    </div>
  );
}

export default CallClient;
