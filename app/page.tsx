"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type LogEntry = {
  id: string;
  type: "armed" | "disarmed" | "triggered" | "cancelled" | "location" | "note";
  message: string;
  timestamp: string;
};

function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);

  return [value, setValue] as const;
}

export default function Page() {
  const [isArmed, setIsArmed] = useLocalStorage<boolean>("armed", false);
  const [isTriggered, setIsTriggered] = useLocalStorage<boolean>("triggered", false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [volume, setVolume] = useLocalStorage<number>("alarmVolume", 0.8);
  const [logs, setLogs] = useLocalStorage<LogEntry[]>("logs", []);
  const [coords, setCoords] = useLocalStorage<{ lat: number; lng: number } | null>(
    "coords",
    null
  );
  const [note, setNote] = useState("");

  const audioCtxRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const wakeLockRef = useRef<any>(null);

  const addLog = useCallback((entry: Omit<LogEntry, "id" | "timestamp">) => {
    setLogs((prev) => [
      {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ...entry,
      },
      ...prev,
    ]);
  }, [setLogs]);

  const requestWakeLock = useCallback(async () => {
    try {
      // @ts-expect-error: experimental API
      if (navigator.wakeLock && !wakeLockRef.current) {
        // @ts-expect-error: experimental API
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }
    } catch {
      // ignore failures
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } catch {}
  }, []);

  const startAlarm = useCallback(async () => {
    if (audioCtxRef.current) return;
    const AudioContextCtor: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContextCtor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = volume;

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(880, ctx.currentTime); // A5

    osc.connect(gain).connect(ctx.destination);
    osc.start();

    audioCtxRef.current = ctx;
    oscillatorRef.current = osc;
    gainRef.current = gain;

    await requestWakeLock();
  }, [volume, requestWakeLock]);

  const stopAlarm = useCallback(async () => {
    try {
      oscillatorRef.current?.stop();
      audioCtxRef.current?.close();
    } catch {}
    oscillatorRef.current = null;
    audioCtxRef.current = null;
    gainRef.current = null;
    await releaseWakeLock();
  }, [releaseWakeLock]);

  useEffect(() => {
    if (!isTriggered) return;
    try {
      navigator.vibrate?.([200, 100, 200, 100, 400]);
    } catch {}
  }, [isTriggered]);

  const obtainLocation = useCallback(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCoords(c);
        addLog({ type: "location", message: `Location updated (${c.lat.toFixed(5)}, ${c.lng.toFixed(5)})` });
      },
      () => {
        addLog({ type: "location", message: "Location access denied" });
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
  }, [setCoords, addLog]);

  const panicMessage = useMemo(() => {
    const base = "PANIC ALERT";
    const time = new Date().toLocaleString();
    const c = coords ? ` @ https://maps.google.com/?q=${coords.lat},${coords.lng}` : "";
    const n = note ? ` ? ${note}` : "";
    return `${base} ? ${time}${c}${n}`;
  }, [coords, note]);

  const shareAlert = useCallback(async () => {
    try {
      // @ts-expect-error web share
      if (navigator.share) {
        // @ts-expect-error web share
        await navigator.share({ title: "Panic Alert", text: panicMessage });
      } else {
        await navigator.clipboard.writeText(panicMessage);
        addLog({ type: "note", message: "Alert message copied to clipboard" });
      }
    } catch {}
  }, [panicMessage, addLog]);

  const arm = useCallback(() => {
    setIsArmed(true);
    addLog({ type: "armed", message: "System armed" });
    obtainLocation();
  }, [setIsArmed, obtainLocation, addLog]);

  const disarm = useCallback(() => {
    setIsArmed(false);
    addLog({ type: "disarmed", message: "System disarmed" });
    setCountdown(null);
    if (isTriggered) {
      setIsTriggered(false);
      stopAlarm();
      addLog({ type: "cancelled", message: "Alarm cancelled" });
    }
  }, [setIsArmed, isTriggered, setIsTriggered, stopAlarm, addLog]);

  const trigger = useCallback(() => {
    if (!isArmed) {
      arm();
    }
    setCountdown(3);
    addLog({ type: "triggered", message: "Panic sequence initiated (3s)" });
  }, [isArmed, arm, addLog]);

  // countdown controller
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setIsTriggered(true);
      setCountdown(null);
      startAlarm();
      obtainLocation();
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c ?? 0) - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, setIsTriggered, startAlarm, obtainLocation]);

  const cancelCountdown = useCallback(() => {
    setCountdown(null);
    addLog({ type: "cancelled", message: "Countdown cancelled" });
  }, [setCountdown, addLog]);

  const stop = useCallback(() => {
    setIsTriggered(false);
    stopAlarm();
    addLog({ type: "cancelled", message: "Alarm stopped" });
  }, [setIsTriggered, stopAlarm, addLog]);

  const copyMessage = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(panicMessage);
      addLog({ type: "note", message: "Alert message copied to clipboard" });
    } catch {}
  }, [panicMessage, addLog]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && isTriggered && audioCtxRef.current?.state === "suspended") {
        audioCtxRef.current.resume();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [isTriggered]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "escape") {
        if (countdown !== null) cancelCountdown();
        if (isTriggered) stop();
      }
      if (e.key.toLowerCase() === " ") {
        e.preventDefault();
        trigger();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trigger, stop, isTriggered, countdown, cancelCountdown]);

  return (
    <main className="grid gap-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Panic Button Dashboard</h1>
        <a className="text-sm text-neutral-400 hover:text-neutral-200 underline" href="/api/health" target="_blank" rel="noreferrer">Health</a>
      </header>

      <section className="grid gap-6 md:grid-cols-2">
        {/* Primary Panel */}
        <div className="card p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className={`h-3 w-3 rounded-full ${isTriggered ? "bg-danger-500 animate-pulse" : isArmed ? "bg-yellow-400" : "bg-neutral-600"}`} />
              <span className="text-sm text-neutral-300">
                {isTriggered ? "ALARM TRIGGERED" : isArmed ? "ARMED" : "DISARMED"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={isArmed ? disarm : arm} className={`btn ${isArmed ? "bg-neutral-700 hover:bg-neutral-600" : "bg-yellow-500 hover:bg-yellow-600"} px-3 py-1.5 text-neutral-900`}>
                {isArmed ? "Disarm" : "Arm"}
              </button>
              <label className="text-sm text-neutral-400">Vol</label>
              <input
                className="accent-danger-500"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center justify-center py-8">
            <button
              onClick={countdown !== null ? cancelCountdown : isTriggered ? stop : trigger}
              className={`rounded-full h-56 w-56 md:h-64 md:w-64 shadow-2xl transition-transform active:scale-95 ${
                isTriggered ? "bg-danger-700" : countdown !== null ? "bg-yellow-500" : "bg-danger-600 hover:bg-danger-700"
              }`}
            >
              <div className="text-center">
                {countdown !== null ? (
                  <>
                    <div className="text-6xl font-black text-neutral-900">{countdown}</div>
                    <div className="text-neutral-900/90 mt-1">Cancel to stop</div>
                  </>
                ) : isTriggered ? (
                  <>
                    <div className="text-3xl font-bold">STOP</div>
                    <div className="text-sm text-neutral-200/80 mt-1">Alarm active</div>
                  </>
                ) : (
                  <>
                    <div className="text-3xl font-bold">PANIC</div>
                    <div className="text-sm text-neutral-200/80 mt-1">Press or hit Space</div>
                  </>
                )}
              </div>
            </button>
          </div>

          <div className="grid gap-3">
            <div className="grid gap-2">
              <label className="text-sm text-neutral-400">Optional note</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g., Walking to parking lot"
                className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-danger-600"
              />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={shareAlert} className="btn btn-primary px-4 py-2">Share Alert</button>
              <button onClick={copyMessage} className="btn bg-neutral-700 hover:bg-neutral-600 px-4 py-2">Copy Alert</button>
              {coords && (
                <a
                  href={`https://maps.google.com/?q=${coords.lat},${coords.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn bg-neutral-800 hover:bg-neutral-700 px-4 py-2"
                >
                  Open Maps
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Info Panel */}
        <div className="card p-6 grid gap-5">
          <div>
            <h2 className="text-lg font-semibold mb-2">Status</h2>
            <div className="text-sm text-neutral-300 grid gap-1">
              <div>
                Mode: <span className="font-medium">{isTriggered ? "ALARM" : isArmed ? "Armed" : "Disarmed"}</span>
              </div>
              <div>
                Location: {coords ? (
                  <span className="font-mono">{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</span>
                ) : (
                  <span className="text-neutral-500">unknown</span>
                )}
              </div>
              <div className="break-all">Message: <span className="text-neutral-400">{panicMessage}</span></div>
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-2">Quick Contacts</h2>
            <div className="grid grid-cols-2 gap-2">
              <a className="btn bg-neutral-800 hover:bg-neutral-700 px-3 py-2" href="tel:911">Call 911</a>
              <a className="btn bg-neutral-800 hover:bg-neutral-700 px-3 py-2" href="sms:?&body=PANIC%20ALERT">Text</a>
              <a className="btn bg-neutral-800 hover:bg-neutral-700 px-3 py-2" href="mailto:?subject=Panic%20Alert&body=PANIC%20ALERT">Email</a>
              <button className="btn bg-neutral-800 hover:bg-neutral-700 px-3 py-2" onClick={() => obtainLocation()}>Refresh Location</button>
            </div>
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-2">Event Log</h2>
            <div className="max-h-64 overflow-auto rounded-md border border-neutral-800">
              {logs.length === 0 ? (
                <div className="p-4 text-sm text-neutral-500">No events yet</div>
              ) : (
                <ul className="divide-y divide-neutral-800">
                  {logs.map((l) => (
                    <li key={l.id} className="p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium capitalize">{l.type}</span>
                        <span className="text-neutral-500">{new Date(l.timestamp).toLocaleString()}</span>
                      </div>
                      <div className="text-neutral-300">{l.message}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </section>

      <footer className="text-center text-xs text-neutral-500">
        Press Space to trigger. Press Esc to cancel.
      </footer>
    </main>
  );
}
