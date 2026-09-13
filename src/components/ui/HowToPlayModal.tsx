"use client";
import { useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useModalA11y } from "@/hooks/useModalA11y";
import {
  MODAL_OVERLAY,
  MODAL_PADDING,
  modalPanel,
  modalHeaderRow,
  modalTitle,
  modalCloseBtn,
} from "@/lib/ui-tokens";

interface HowToPlayModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const HowToPlayModal = ({ isOpen, onClose }: HowToPlayModalProps) => (
  <AnimatePresence>
    {isOpen && <HowToPlayModalContent onClose={onClose} />}
  </AnimatePresence>
);

interface ControlRow {
  input: string;
  action: string;
}

const KEYBOARD_CONTROLS: ControlRow[] = [
  { input: "← / →", action: "Steer the ship left and right" },
  {
    input: "Space (hold)",
    action: "Fire primary volley (auto-repeats with RAPID buff)",
  },
  { input: "Ctrl (hold)", action: "Fire the laser beam — drains energy fast" },
  { input: "P or Esc", action: "Pause / resume" },
  { input: "M", action: "Mute / unmute audio" },
  { input: "F3", action: "Toggle performance overlay" },
  { input: "R", action: "Restart after game over" },
];

const TOUCH_CONTROLS: ControlRow[] = [
  { input: "Touch & drag", action: "Steer toward your finger" },
  { input: "Touch (hold)", action: "Fire primary volley while steering" },
  {
    input: "Second finger (hold)",
    action:
      "Fire the laser beam while first finger steers — drains energy fast",
  },
];

const POWER_UPS: ControlRow[] = [
  { input: "RAPID", action: "Held fire auto-repeats at high cadence" },
  { input: "SHIELD", action: "Absorbs one hit entirely" },
  { input: "MULTI", action: "Widens each volley to the outer lanes" },
  { input: "SPEED", action: "Boosts steering speed" },
];

function ControlTable({ title, rows }: { title: string; rows: ControlRow[] }) {
  return (
    <section>
      <h3 className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.25em] text-cyan-500/70 mb-2">
        {title}
      </h3>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.input}
            className="grid grid-cols-[8rem_1fr] sm:grid-cols-[10rem_1fr] items-start gap-3 text-sm"
          >
            <kbd className="text-center px-2 py-1 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 font-mono text-xs">
              {row.input}
            </kbd>
            <span className="text-white/80">{row.action}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const HowToPlayModalContent = ({
  onClose,
}: Omit<HowToPlayModalProps, "isOpen">) => {
  const dismiss = useCallback(() => onClose(), [onClose]);
  const panelRef = useModalA11y<HTMLDivElement>(dismiss);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={MODAL_OVERLAY}
      onClick={dismiss}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="how-to-play-title"
        initial={{ scale: 0.95, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 16 }}
        className={`${modalPanel("cyan", "lg")} ${MODAL_PADDING} overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={modalHeaderRow("cyan")}>
          <h2 id="how-to-play-title" className={modalTitle("cyan")}>
            How To Play
          </h2>
          <button
            onClick={dismiss}
            className={modalCloseBtn("cyan")}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-6 text-left">
          <section>
            <h3 className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.25em] text-cyan-500/70 mb-2">
              Mission
            </h3>
            <p className="text-sm text-white/80 leading-relaxed">
              Survive endless waves of aliens and bosses. Destroy them for
              score, dodge their shots, and grab falling salvage crates and
              power-ups. Your run ends when your ship&apos;s lives hit zero —
              bosses heal you by one life when defeated.
            </p>
          </section>

          <ControlTable title="Keyboard" rows={KEYBOARD_CONTROLS} />
          <ControlTable title="Touch" rows={TOUCH_CONTROLS} />
          <ControlTable title="Power-ups" rows={POWER_UPS} />

          <section>
            <h3 className="text-[10px] sm:text-xs font-mono uppercase tracking-[0.25em] text-cyan-500/70 mb-2">
              Energy
            </h3>
            <p className="text-sm text-white/80 leading-relaxed">
              Primary volleys and the laser drain energy; it regenerates over
              time. Run dry and the ship enters cooldown until it recovers past
              20%.
            </p>
          </section>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default HowToPlayModal;
