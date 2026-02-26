import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef, useCallback } from "react";
import { Megaphone, Trophy, Zap, Star, X } from "lucide-react";
import type { TickerMessage } from "@shared/schema";

const priorityConfig = {
  urgent: { icon: Zap, bgClass: "bg-red-500/10 border-red-500/30", textClass: "text-red-400", iconClass: "text-red-400" },
  high: { icon: Trophy, bgClass: "bg-amber-500/10 border-amber-500/30", textClass: "text-amber-300", iconClass: "text-amber-400" },
  normal: { icon: Megaphone, bgClass: "bg-primary/5 border-primary/20", textClass: "text-foreground", iconClass: "text-primary" },
};

const typeIcons: Record<string, typeof Star> = {
  milestone: Star,
  immediate: Megaphone,
  scheduled: Megaphone,
};

/** Scrolls text horizontally when it overflows its container */
function MarqueeText({ text, className, paused }: { text: string; className?: string; paused?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [shouldScroll, setShouldScroll] = useState(false);
  const [duration, setDuration] = useState(10);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const span = textRef.current;
    if (!container || !span) return;
    const overflow = span.scrollWidth > container.clientWidth + 2;
    setShouldScroll(overflow);
    if (overflow) {
      // ~50px per second scroll speed
      setDuration(Math.max(5, span.scrollWidth / 50));
    }
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, measure]);

  return (
    <div ref={containerRef} className="overflow-hidden whitespace-nowrap">
      <span
        ref={textRef}
        className={`${className} inline-block ${shouldScroll ? "animate-marquee" : ""}`}
        style={shouldScroll ? { animationDuration: `${duration}s`, animationPlayState: paused ? "paused" : "running" } : undefined}
      >
        {text}
        {shouldScroll && (
          <>
            <span className="mx-12" aria-hidden="true">•</span>
            <span aria-hidden="true">{text}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** Expanded popover showing the full message text, wrapping naturally */
function ExpandedMessage({ message, onClose }: { message: TickerMessage; onClose: () => void }) {
  const prio = priorityConfig[message.priority as keyof typeof priorityConfig] || priorityConfig.normal;
  const PrioIcon = message.type === "milestone" ? Star : prio.icon;

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2 }}
      className={`rounded-lg border ${prio.bgClass} px-4 py-3 shadow-lg`}
    >
      <div className="flex items-start gap-3">
        <div className={`shrink-0 mt-0.5 ${prio.iconClass}`}>
          <PrioIcon className="w-4 h-4" />
        </div>
        <p className={`text-sm font-medium ${prio.textClass} flex-1 whitespace-normal break-words`}>
          {message.message}
        </p>
        <button
          onClick={onClose}
          className="shrink-0 ml-2 p-1 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </motion.div>
  );
}

export function BannerTicker() {
  const { data } = useQuery<{ messages: TickerMessage[] }>({
    queryKey: ["/api/ticker/messages"],
    refetchInterval: 30 * 1000, // Refresh every 30 seconds
  });

  const messages = data?.messages || [];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Cycle through messages — paused while a message is expanded
  useEffect(() => {
    if (messages.length <= 1 || expandedId) return;
    const interval = setInterval(() => {
      setCurrentIndex(prev => (prev + 1) % messages.length);
    }, 10000); // 10 seconds per message
    return () => clearInterval(interval);
  }, [messages.length, expandedId]);

  // Reset index if messages change
  useEffect(() => {
    if (currentIndex >= messages.length) {
      setCurrentIndex(0);
    }
  }, [messages.length, currentIndex]);

  if (messages.length === 0) return null;

  const current = messages[currentIndex];
  if (!current) return null;

  const isExpanded = expandedId === current.id;
  const prio = priorityConfig[current.priority as keyof typeof priorityConfig] || priorityConfig.normal;
  const PrioIcon = prio.icon;

  return (
    <AnimatePresence mode="wait">
      {isExpanded ? (
        <ExpandedMessage
          key={`expanded-${current.id}`}
          message={current}
          onClose={() => setExpandedId(null)}
        />
      ) : (
        <motion.div
          key="ticker"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={`relative overflow-hidden rounded-lg border ${prio.bgClass} px-4 py-2 cursor-pointer`}
          onClick={() => setExpandedId(current.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setExpandedId(current.id); }}
        >
          <div className="flex items-center gap-3">
            {/* Icon */}
            <div className={`shrink-0 ${prio.iconClass}`}>
              {current.type === "milestone" ? (
                <Star className="w-4 h-4" />
              ) : (
                <PrioIcon className="w-4 h-4" />
              )}
            </div>

            {/* Scrolling message area */}
            <div className="flex-1 overflow-hidden relative min-h-[1.5rem]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={current.id}
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -20, opacity: 0 }}
                  transition={{ duration: 0.4, ease: "easeInOut" }}
                >
                  <MarqueeText text={current.message} className={`text-sm font-medium ${prio.textClass}`} />
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Message counter */}
            {messages.length > 1 && (
              <div className="shrink-0 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                {messages.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrentIndex(idx)}
                    className={`w-1.5 h-1.5 rounded-full transition-all ${
                      idx === currentIndex
                        ? "bg-primary w-4"
                        : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
